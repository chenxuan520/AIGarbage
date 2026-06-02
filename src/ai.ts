import type { GenConfig } from "./config";
import type { ChatMessage } from "./prompts";
import type { Env } from "./types";

// Qwen3 is a reasoning model; appending /no_think disables the hidden
// "thinking" so it returns the answer directly (and cheaply).
function maybeDisableThinking(model: string, messages: ChatMessage[]): ChatMessage[] {
  if (!/qwen3/i.test(model)) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      out[i].content = `${out[i].content.trimEnd()} /no_think`;
      break;
    }
  }
  return out;
}

// Some reasoning models (GLM-4.x, etc.) may leak their chain-of-thought inline
// as <think>/<thought> blocks or end it with a `<｜end▁of▁thinking｜>` marker.
// Strip all of that so only the final answer survives.
function stripReasoning(s: string): string {
  let out = s;
  // Everything up to and including an end-of-thinking marker is reasoning.
  const m = out.match(/<[^>]*end[\s_▁｜|]*of[\s_▁｜|]*think(?:ing)?[^>]*>/i);
  if (m && m.index !== undefined) out = out.slice(m.index + m[0].length);
  out = out
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  return out.trim();
}

// Coerce a field to text. CRITICAL: when a model outputs clean JSON, Workers AI
// parses it and returns `response` (or `content`) as an OBJECT, not a string —
// e.g. llama returns `{response:{score:88}}`. The reviewer/selector emit JSON,
// so we must JSON.stringify objects here or those calls look empty.
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

// Handle both the OpenAI-style `{choices:[{message:{content}}]}` shape used by
// newer models and the classic `{response}` shape. IMPORTANT: read only the
// `content` field — reasoning models keep their thinking in a separate
// `reasoning`/`reasoning_content` field which we must ignore.
function extractText(res: unknown): string {
  const r = res as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };
  const choice = r?.choices?.[0];
  const content = asText(choice?.message?.content);
  if (content.trim()) return stripReasoning(content);
  const response = asText(r?.response);
  if (response.trim()) return stripReasoning(response);
  const text = asText(choice?.text);
  if (text.trim()) return stripReasoning(text);
  return "";
}

// repetition_penalty destabilizes some reasoning models (notably GLM-4.x):
// on long generations they hit the token cap and spiral into a garbled
// English word-salad loop. Skip the penalty for those families.
function usesRepetitionPenalty(model: string): boolean {
  return !/(glm|deepseek-r1|qwq|gpt-oss)/i.test(model);
}

/** Call a user-supplied OpenAI-compatible chat-completions endpoint. */
async function runOpenAICompatible(
  cfg: GenConfig,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  const base = cfg.apiBaseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      top_p: 0.9,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`custom model HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  return extractText(await res.json());
}

/**
 * Run a text-generation model and return the response string. Routes to a
 * custom OpenAI-compatible endpoint when `cfg.provider === "openai"`,
 * otherwise uses the Workers AI binding.
 */
export async function runText(
  env: Env,
  model: string,
  messages: ChatMessage[],
  maxTokens = 1024,
  cfg?: GenConfig,
): Promise<string> {
  if (cfg?.provider === "openai" && cfg.apiBaseUrl) {
    return runOpenAICompatible(cfg, model, messages, maxTokens);
  }
  // Workers AI types are strict about model ids; cast to keep them configurable.
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
  };
  const inputs: Record<string, unknown> = {
    messages: maybeDisableThinking(model, messages),
    max_tokens: maxTokens,
    temperature: 0.7,
    top_p: 0.9,
  };
  // Mild penalty helps small MoEs avoid loops, but breaks GLM-style reasoning
  // models — only send it where it's safe.
  if (usesRepetitionPenalty(model)) inputs.repetition_penalty = 1.1;
  const res = await ai.run(model, inputs);
  return extractText(res);
}

// FLUX.2 [klein]/[dev] on Workers AI take multipart/form-data input (even for a
// plain prompt) and have a FIXED 4-step process — the older `{prompt, steps}`
// JSON shape used by flux-1-schnell does not apply.
function isMultipartImageModel(model: string): boolean {
  return /flux-2/i.test(model);
}

type ImageRunResult = { image?: string } | ArrayBuffer | Uint8Array | string;

/** Decode whatever the image model returned (base64 string or raw bytes). */
function decodeImage(res: ImageRunResult): Uint8Array {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  const b64 = typeof res === "string" ? res : (res?.image ?? "");
  if (!b64) throw new Error("image model returned no data");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Generate an image and return raw bytes. Always uses the Workers AI binding. */
export async function generateImageBytes(
  env: Env,
  prompt: string,
  model = env.AI_MODEL_IMAGE,
): Promise<Uint8Array> {
  const width = parseInt(env.IMAGE_WIDTH || "1024", 10);
  const height = parseInt(env.IMAGE_HEIGHT || "576", 10);
  const seed = Math.floor(Math.random() * 1_000_000);
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>) => Promise<ImageRunResult>;
  };

  if (isMultipartImageModel(model)) {
    // Build multipart body the way the runtime expects: a FormData serialized
    // via Response so the boundary-bearing content-type header is generated.
    // `steps` is fixed at 4 for the distilled klein models, so we omit it.
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("seed", String(seed));
    const serialized = new Response(form);
    const body = serialized.body;
    const contentType = serialized.headers.get("content-type") ?? "multipart/form-data";
    const res = await ai.run(model, { multipart: { body, contentType } });
    return decodeImage(res);
  }

  const res = await ai.run(model, { prompt, width, height, steps: 4, seed });
  return decodeImage(res);
}

/** Best-effort JSON extraction from a (possibly noisy) model response. */
export function parseJsonLoose<T>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

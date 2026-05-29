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

// Handle both the classic `{response}` shape and the OpenAI-style
// `{choices:[{message:{content}}]}` shape used by newer models.
function extractText(res: unknown): string {
  const r = res as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };
  if (typeof r?.response === "string") return r.response.trim();
  const choice = r?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content.trim();
  if (typeof choice?.text === "string") return choice.text.trim();
  return "";
}

/** Run a text-generation model and return the response string. */
export async function runText(
  env: Env,
  model: string,
  messages: ChatMessage[],
  maxTokens = 1024,
): Promise<string> {
  // Workers AI types are strict about model ids; cast to keep them configurable.
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
  };
  const res = await ai.run(model, {
    messages: maybeDisableThinking(model, messages),
    max_tokens: maxTokens,
    // Mild settings: enough to avoid loops, not so aggressive that the model
    // produces incoherent word-salad (which heavy penalties caused on small MoEs).
    temperature: 0.7,
    top_p: 0.9,
    repetition_penalty: 1.1,
  });
  return extractText(res);
}

/** Generate a cover image and return raw bytes (jpeg). */
export async function generateImageBytes(env: Env, prompt: string): Promise<Uint8Array> {
  const width = parseInt(env.IMAGE_WIDTH || "1024", 10);
  const height = parseInt(env.IMAGE_HEIGHT || "576", 10);
  const ai = env.AI as unknown as {
    run: (model: string, inputs: Record<string, unknown>) => Promise<{ image?: string }>;
  };
  const res = await ai.run(env.AI_MODEL_IMAGE, {
    prompt,
    width,
    height,
    steps: 4,
    seed: Math.floor(Math.random() * 1_000_000),
  });
  const b64 = res?.image ?? "";
  if (!b64) throw new Error("image model returned no data");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

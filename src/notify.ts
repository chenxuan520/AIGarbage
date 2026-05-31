import type { Env } from "./types";

function b64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Feishu/Lark custom-bot signature: base64(HMAC-SHA256(key=`${ts}\n${secret}`,
 * msg="")). Only needed when the bot has 加签 (signed verification) enabled.
 */
async function larkSign(secret: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(await crypto.subtle.sign("HMAC", key, new Uint8Array(0)));
}

interface LarkPayload {
  msg_type: string;
  card: unknown;
  timestamp?: string;
  sign?: string;
}

/**
 * Best-effort failure alert to a Feishu/Lark webhook. No-op when the webhook
 * isn't configured; never throws (so it can't break generation).
 */
export async function notifyLark(env: Env, title: string, detail = ""): Promise<void> {
  const url = env.LARK_WEBHOOK_URL;
  if (!url) return;

  const site = env.SITE_TITLE || "智见";
  const when = `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  const text = `**站点**：${site}\n**时间**：${when}\n**详情**：${detail || "无"}`;

  const payload: LarkPayload = {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: "red",
        title: { tag: "plain_text", content: `⚠️ ${site} · ${title}` },
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
    },
  };

  if (env.LARK_WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = ts;
    payload.sign = await larkSign(env.LARK_WEBHOOK_SECRET, ts);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("lark notify HTTP", res.status, (await res.text().catch(() => "")).slice(0, 200));
    }
  } catch (e) {
    console.error("lark notify failed:", e);
  }
}

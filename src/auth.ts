import type { Env } from "./types";

const COOKIE = "zj_sid";
const TTL_S = 7 * 24 * 3600; // 7 days

// Cloudflare's documented Turnstile TEST keys (always pass / always present).
export const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

export function adminUser(env: Env): string {
  return env.ADMIN_USER || "admin";
}
function adminPass(env: Env): string {
  return env.ADMIN_PASS || "admin888";
}
export function siteKey(env: Env): string {
  return env.TURNSTILE_SITE_KEY || TEST_SITE_KEY;
}
function signingSecret(env: Env): string {
  return env.ADMIN_KEY || env.ADMIN_PASS || "zhijian-demo-secret";
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

// Constant-time-ish string comparison.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkCredentials(env: Env, user: string, pass: string): boolean {
  return safeEqual(user, adminUser(env)) && safeEqual(pass, adminPass(env));
}

export async function makeSession(env: Env): Promise<string> {
  const payload = `${adminUser(env)}|${Date.now() + TTL_S * 1000}`;
  const sig = await hmac(signingSecret(env), payload);
  return `${btoa(payload)}.${sig}`;
}

async function verifySession(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = atob(b64);
  } catch {
    return false;
  }
  const [user, expStr] = payload.split("|");
  if (!user || !expStr || Date.now() > Number(expStr)) return false;
  const expect = await hmac(signingSecret(env), payload);
  return safeEqual(sig, expect) && safeEqual(user, adminUser(env));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export async function isAuthed(request: Request, env: Env): Promise<boolean> {
  return verifySession(env, readCookie(request, COOKIE));
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_S}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Verify a Turnstile token server-side. Test keys always succeed. */
export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string | null,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY || TEST_SECRET_KEY;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token || "");
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

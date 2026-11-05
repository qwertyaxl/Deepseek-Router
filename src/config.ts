import type { RouterConfig } from "./types.js";

const DEFAULT_MODELS = ["deepseek-web", "deepseek-web-thinking"];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function loadToken(env: NodeJS.ProcessEnv, directName: string, fileName: string): string {
  const direct = env[directName]?.trim() || "";
  const file = env[fileName]?.trim();
  if (direct && file) {
    throw new Error(`Set only one of ${directName} or ${fileName}`);
  }
  let raw = direct || (file ? readTrimmed(file) : "");
  if (raw.startsWith("userToken=")) raw = raw.slice("userToken=".length).trim();
  return raw;
}

function readTrimmed(path: string): string {
  return readFileSyncText(path).trim();
}

import { readFileSync } from "node:fs";
function readFileSyncText(path: string): string {
  return readFileSync(path, "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const allowNonLoopback = env.ALLOW_NON_LOOPBACK === "true";
  if (!LOOPBACK_HOSTS.has(host) && !allowNonLoopback) {
    throw new Error(
      `Refusing non-loopback HOST=${host}. Set ALLOW_NON_LOOPBACK=true only if you understand the risk.`,
    );
  }

  const models = (env.DEEPSEEK_MODELS?.split(",") ?? DEFAULT_MODELS)
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) throw new Error("DEEPSEEK_MODELS must contain at least one model");

  return {
    host,
    port: positiveInt(env.PORT, 20129, "PORT"),
    routerApiKey: env.ROUTER_API_KEY?.trim() || "",
    userToken: loadToken(env, "DEEPSEEK_USER_TOKEN", "DEEPSEEK_USER_TOKEN_FILE"),
    // Preferred auth: the Bearer token DeepSeek web sends to its API
    // (DevTools -> Network -> request to chat.deepseek.com -> `authorization` header,
    // value after "Bearer "). Captured sample: "hvlt/...".
    bearerToken: env.DEEPSEEK_BEARER_TOKEN?.trim() || "",
    // Full raw Cookie header (e.g. ".thumbcache_x=...; ds_session_id=...; aws-waf-token=...").
    rawCookie: env.DEEPSEEK_COOKIE?.trim() || "",
    baseUrl: "https://chat.deepseek.com",
    models,
    thinkingEnabled: env.DEEPSEEK_THINKING_ENABLED !== "false",
    requestTimeoutMs: positiveInt(env.REQUEST_TIMEOUT_MS, 120_000, "REQUEST_TIMEOUT_MS"),
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, 2 * 1024 * 1024, "MAX_BODY_BYTES"),
  };
}

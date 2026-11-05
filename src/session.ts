import { HttpError } from "./errors.js";
import { solvePow, type PowChallenge } from "./pow.js";
import { nativeSolve, nativeAvailable } from "./pow-native.js";
import type { RouterConfig } from "./types.js";

type FetchLike = typeof fetch;

export interface DeepSeekDependencies {
  fetch?: FetchLike;
  now?: () => number;
}

const BASE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  "x-client-platform": "web",
  "x-client-version": "2.5.0",
  "x-client-bundle-id": "com.deepseek.chat",
  "x-client-locale": "en_US",
  "x-client-timezone-offset": "0",
};

function authHeaders(config: RouterConfig): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (config.bearerToken) {
    headers["authorization"] = `Bearer ${config.bearerToken}`;
  }
  if (config.rawCookie) {
    headers["cookie"] = config.rawCookie;
  }
  return headers;
}

interface ChallengeEnvelope {
  code: number;
  data?: { biz_code?: number; biz_data?: { challenge?: PowChallenge } };
}

export interface DeepSeekSession {
  /** Create a new chat session; returns its id. */
  createChatSession(): Promise<string>;
  /** Fetch a fresh PoW challenge for the completion endpoint and solve it. */
  solveFor(targetPath: string): Promise<string>;
}

export function createDeepSeekSession(
  config: RouterConfig,
  deps: DeepSeekDependencies = {},
): DeepSeekSession {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const headers = authHeaders(config);

  async function createChatSession(): Promise<string> {
    const response = await doFetch(`${baseUrl}/api/v0/chat_session/create`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new HttpError(502, `chat_session/create failed: HTTP ${response.status}`, "upstream_error");
    }
    const payload = (await response.json()) as {
      code?: number;
      data?: { biz_data?: { chat_session?: { id?: string } } };
    };
    const id = payload.data?.biz_data?.chat_session?.id;
    if (typeof id !== "string" || !id) {
      throw new HttpError(401, "Session creation rejected — token likely expired", "session_expired");
    }
    console.error(`[session] created web chat_session ${id}`);
    return id;
  }

  async function solveFor(targetPath: string): Promise<string> {
    const response = await doFetch(`${baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ target_path: targetPath }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new HttpError(502, `pow challenge request failed: HTTP ${response.status}`, "upstream_error");
    }
    const payload = (await response.json()) as ChallengeEnvelope;
    const challenge = payload.data?.biz_data?.challenge;
    if (!challenge || !challenge.challenge || !challenge.salt) {
      throw new HttpError(401, "PoW challenge rejected — token likely expired", "session_expired");
    }
    // Native-first: the compiled helper solves in ~50-120 ms vs ~12 s in JS.
    const answer = nativeAvailable()
      ? (await nativeSolve(challenge)) ?? solvePow(challenge)
      : solvePow(challenge);
    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm || "DeepSeekHashV1",
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: targetPath,
      }),
    ).toString("base64");
  }

  return { createChatSession, solveFor };
}

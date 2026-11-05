import type { RouterConfig } from "./types.js";
import { createDeepSeekSession, type DeepSeekSession } from "./session.js";

type FetchLike = typeof fetch;

export interface AccountConfig {
  id: string;
  bearerToken: string;
  cookie: string;
}

export interface AccountState {
  account: AccountConfig;
  session: DeepSeekSession;
  /** sticky conversation -> web chat_session id + parent message id */
  conversations: Map<string, { chatSessionId: string; parentMessageId: number | null; lastUsed: number }>;
  /** rate-limited until this wall clock (ms) */
  cooldownUntil: number;
  /** consecutive empty/failed turns */
  failures: number;
  requests: number;
}

export interface PickedTurn {
  state: AccountState;
  chatSessionId: string;
  parentMessageId: number | null;
}

/**
 * Multi-account rotation with health tracking:
 * - round-robins across accounts, skipping ones in rate-limit cooldown;
 * - per-account sticky conversation map (task continuity);
 * - on 429 the caller marks the account cooled down and the next pick rotates;
 * - accounts with repeated failures are deprioritized (quarantined for 10 min).
 */
export class AccountPool {
  private states: AccountState[] = [];
  private cursor = 0;

  constructor(
    config: RouterConfig,
    accounts: AccountConfig[],
    private createSession: (cfg: RouterConfig, acc: AccountConfig) => DeepSeekSession = (cfg, acc) => {
      const scoped: RouterConfig = { ...config, bearerToken: acc.bearerToken, rawCookie: acc.cookie };
      return createDeepSeekSession(scoped);
    },
    private ttlMs = 20 * 60 * 1000,
  ) {
    for (const acc of accounts) {
      this.states.push({
        account: acc,
        session: createSession(config, acc),
        conversations: new Map(),
        cooldownUntil: 0,
        failures: 0,
        requests: 0,
      });
    }
  }

  get size(): number {
    return this.states.length;
  }

  private prune(): void {
    const now = Date.now();
    for (const st of this.states) {
      for (const [key, val] of st.conversations) {
        if (now - val.lastUsed > this.ttlMs) st.conversations.delete(key);
      }
    }
  }

  /** Pick the next healthy account and its sticky turn for the conversation. */
  async pick(conversationId: string): Promise<PickedTurn> {
    this.prune();
    const now = Date.now();
    const n = this.states.length;
    for (let i = 0; i < n; i++) {
      const st = this.states[(this.cursor + i) % n]!;
      if (st.cooldownUntil > now) continue;
      this.cursor = (this.cursor + i + 1) % n;

      let conv = st.conversations.get(conversationId);
      if (!conv) {
        const chatSessionId = await st.session.createChatSession();
        conv = { chatSessionId, parentMessageId: null, lastUsed: now };
        st.conversations.set(conversationId, conv);
      } else {
        conv.lastUsed = now;
      }
      st.requests++;
      return { state: st, chatSessionId: conv.chatSessionId, parentMessageId: conv.parentMessageId };
    }
    // Every account is cooling down: wait for the soonest cooldown and use it.
    const soonest = this.states.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b));
    const waitMs = Math.max(0, soonest.cooldownUntil - now);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)));
    const chatSessionId = await soonest.session.createChatSession();
    soonest.conversations.set(conversationId, { chatSessionId, parentMessageId: null, lastUsed: Date.now() });
    return { state: soonest, chatSessionId, parentMessageId: null };
  }

  markRateLimited(st: AccountState, cooldownMs = 5 * 60 * 1000): void {
    st.cooldownUntil = Date.now() + cooldownMs;
    st.failures++;
  }

  markFailure(st: AccountState): void {
    st.failures++;
    if (st.failures >= 3) st.cooldownUntil = Date.now() + 10 * 60 * 1000;
  }

  markSuccess(st: AccountState): void {
    st.failures = 0;
  }

  /** Force a fresh web chat session for the conversation (server-side context reset). */
  async rotateConversation(st: AccountState, conversationId: string): Promise<{ chatSessionId: string; parentMessageId: number | null }> {
    const chatSessionId = await st.session.createChatSession();
    st.conversations.set(conversationId, { chatSessionId, parentMessageId: null, lastUsed: Date.now() });
    return { chatSessionId, parentMessageId: null };
  }

  setLastMessageId(st: AccountState, conversationId: string, messageId: number | null): void {
    if (messageId === null) return;
    const conv = st.conversations.get(conversationId);
    if (conv) conv.parentMessageId = messageId;
  }

  stats(): Array<{ id: string; requests: number; failures: number; cooldown: number; conversations: number }> {
    const now = Date.now();
    return this.states.map((st) => ({
      id: st.account.id,
      requests: st.requests,
      failures: st.failures,
      cooldown: Math.max(0, st.cooldownUntil - now),
      conversations: st.conversations.size,
    }));
  }
}

/** Load accounts from env: DEEPSEEK_ACCOUNTS="id1:token1:cookie1;id2:token2:cookie2" */
export function loadAccounts(env: NodeJS.ProcessEnv, fallback: { bearerToken: string; cookie: string }): AccountConfig[] {
  const raw = env.DEEPSEEK_ACCOUNTS?.trim();
  const accounts: AccountConfig[] = [];
  if (raw) {
    for (const entry of raw.split(";")) {
      const parts = entry.trim().split(":");
      if (parts.length < 2) continue;
      const [id, bearerToken, ...rest] = parts as [string, string, ...string[]];
      accounts.push({ id, bearerToken, cookie: rest.join(":") || fallback.cookie });
    }
  }
  if (accounts.length === 0 && fallback.bearerToken) {
    accounts.push({ id: "primary", bearerToken: fallback.bearerToken, cookie: fallback.cookie });
  }
  return accounts;
}

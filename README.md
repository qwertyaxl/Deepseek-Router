# deepseek-web-router

A local OpenAI-compatible bridge to a **personal DeepSeek web session**
(`chat.deepseek.com`). It exposes `/v1/responses` (Codex) and
`/v1/chat/completions` on loopback, authenticates with your browser session,
solves DeepSeek's proof-of-work, and translates the web SSE protocol into
OpenAI-style responses — including tool calls, so Codex can run agentically.

> [!WARNING]
> Unofficial and experimental. It uses **private web endpoints**, not the
> official API. It can break whenever DeepSeek changes its frontend, auth flow,
> PoW scheme or SSE protocol. Using it may violate DeepSeek's terms of service
> and can put your account at risk. Use only your own account, at your own risk.
> For anything production-grade use the official API: <https://api-docs.deepseek.com>.

## Features

- **Responses API** (`/v1/responses`) with Codex-compatible streaming events:
  `response.created`, `output_item.added`, `output_text.delta`,
  `output_item.done`, `response.completed`.
- **Chat Completions** (`/v1/chat/completions`), streaming and non-streaming.
- **Tool calls over a text protocol.** The web API has no native tools, so the
  router injects the client's tool schemas into the prompt as DSML instructions
  and parses the model's DSML blocks back into OpenAI `function_call` items.
  Several real-world DSML variants are normalized (single-bar tags, bare
  closers, merged parameter values, glued `workdir` tails).
- **Sticky sessions.** One web chat session per `x-conversation-id` (default
  `default`), with `parent_message_id` chaining so the model keeps server-side
  memory within a task. Idle sessions are pruned after 20 minutes.
- **Auto-continue.** If the web message is cut off, the router calls
  `/api/v0/chat/continue` and merges the continuation.
- **Empty-turn recovery.** A completion with no text and no thinking triggers a
  session rotation and one retry. Streaming is buffer-first, so Codex never
  receives an empty "completed" response.
- **Rate-limit awareness.** DeepSeek throttling arrives as an in-band SSE hint
  on HTTP 200 (`rate_limit_reached`). The router converts it to HTTP 429 and
  puts the account on a cooldown instead of returning a silent empty answer.
- **Multi-account rotation** (`DEEPSEEK_ACCOUNTS`): round-robin, cooldown on
  429, quarantine after repeated failures. Inspect with `GET /pool`.
- **Thinking and web search toggles** (`DEEPSEEK_THINKING_ENABLED`,
  `DEEPSEEK_THINKING_DEFAULT`, `DEEPSEEK_SEARCH`).
- **Native PoW solver** in C++ via WSL (~50–120 ms per solve) with automatic
  fallback to the JavaScript solver.
- **Loopback-only by default**, optional `ROUTER_API_KEY` bearer auth for local
  clients.

## Architecture

```
OpenAI-compatible client (Codex CLI, curl, ...)
   |  Authorization: Bearer <ROUTER_API_KEY>   (+ x-conversation-id)
   |  POST /v1/responses | /v1/chat/completions
   v
deepseek-web-router  127.0.0.1:20129
   |  1. POST /api/v0/chat/create_pow_challenge   solve DeepSeekHashV1
   |  2. POST /api/v0/chat_session/create         sticky session
   |  3. POST /api/v0/chat/completion             SSE (userToken cookie + PoW header)
   |  4. POST /api/v0/chat/continue               only when the message is truncated
   v
chat.deepseek.com
```

Request flow inside the router:

1. resolve/create a web chat session for the conversation id;
2. solve the PoW challenge (native helper, JS fallback);
3. build a single prompt from the client's messages (tool schemas appended);
4. stream the web SSE, normalizing fragments (`THINK` / `RESPONSE`), DSML blocks
   and JSON-patch deltas;
5. emit OpenAI Responses events or Chat Completions chunks;
6. track the last `message_id` for continuation and session recovery.

## Requirements

- Node.js **22+** and npm
- Your own DeepSeek web account and a captured browser session
- Optional: WSL + `g++` for the native PoW helper
- Optional: Codex CLI (`codex`) if you want the Codex integration

## Quick start

```bash
npm install
cp .env.example .env     # fill in tokens and ROUTER_API_KEY
npm run dev              # tsx, reads .env
```

Production-ish start:

```bash
npm run build
npm start
```

Health and catalog:

```bash
curl http://127.0.0.1:20129/health
curl -H "Authorization: Bearer $ROUTER_API_KEY" http://127.0.0.1:20129/v1/models
curl -H "Authorization: Bearer $ROUTER_API_KEY" http://127.0.0.1:20129/pool
```

Chat Completions:

```bash
curl http://127.0.0.1:20129/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-web","messages":[{"role":"user","content":"Hi"}]}'
```

Responses (streaming):

```bash
curl -N http://127.0.0.1:20129/v1/responses \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-web","input":[{"role":"user","content":[{"type":"input_text","text":"Say OK"}]}],"stream":true}'
```

## Capturing the session

1. Open <https://chat.deepseek.com> in a browser and log in.
2. DevTools → Network → any request to `chat.deepseek.com`.
3. Copy the **request header** `authorization: Bearer hvlt/...` → `DEEPSEEK_BEARER_TOKEN`
   (paste everything after `Bearer `).
4. Copy the **request header** `cookie: ...` (full line) → `DEEPSEEK_COOKIE`.
5. Generate a random `ROUTER_API_KEY` (e.g. `openssl rand -hex 24`).

The session expires after a few weeks. When it does, `/v1/*` returns `401` with
`session_expired`; capture a fresh token.

## Configuration

All variables live in `.env` (loaded by `--env-file-if-exists=.env`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_BEARER_TOKEN` | — | `authorization` header value from the web session (required) |
| `DEEPSEEK_COOKIE` | — | full raw `cookie` header (required) |
| `DEEPSEEK_USER_TOKEN` | — | legacy alternative: bare `userToken` cookie |
| `ROUTER_API_KEY` | empty | bearer token required from local clients |
| `HOST` | `127.0.0.1` | bind address (non-loopback refused unless allowed) |
| `PORT` | `20129` | listen port |
| `REQUEST_TIMEOUT_MS` | `120000` | upstream request timeout |
| `MAX_BODY_BYTES` | `2097152` | maximum accepted request body |
| `DEEPSEEK_MODELS` | `deepseek-web,deepseek-web-thinking` | catalog for `/v1/models` |
| `DEEPSEEK_THINKING_ENABLED` | `true` | request thinking for the `*thinking*` model |
| `DEEPSEEK_THINKING_DEFAULT` | `false` | upgrade plain requests to thinking |
| `DEEPSEEK_SEARCH` | `true` | enable DeepSeek web search |
| `DEEPSEEK_MIN_INTERVAL_MS` | `20000` | minimum spacing between upstream calls |
| `DEEPSEEK_RATE_RETRIES` | `5` | retries on rate-limit responses |
| `DEEPSEEK_BACKOFF_MS` | `60000` | base backoff between retries |
| `DEEPSEEK_ACCOUNTS` | — | `id:bearer:cookie` entries separated by `;` |
| `ALLOW_NON_LOOPBACK` | `false` | allow binding to a non-loopback host (dangerous) |
| `DPS_POW_WSL` | `//wsl.localhost/Ubuntu/home/<user>/dps-router/dps-pow` | native solver UNC path |
| `DPS_POW_WSL_PATH` | `/home/<user>/dps-router/dps-pow` | native solver path inside WSL |

## Using with Codex CLI

### Option A — wrapper (no global config changes)

```bash
npm run codex:ds
# forwards every extra argument to codex
npm run codex:ds -- exec "write a hello world"
```

The wrapper sets the provider on the command line:
`-c model_provider=dsweb`, `base_url=http://127.0.0.1:<port>/v1`,
`wire_api="responses"`, `env_key=null`, and supplies `OPENAI_API_KEY` so Codex's
auth check is satisfied.

### Option B — persistent `~/.codex/config.toml`

```toml
model = "deepseek-web"
model_provider = "dsweb"
model_reasoning_effort = "high"

[model_providers.dsweb]
name = "DeepSeek Web Router"
base_url = "http://127.0.0.1:20129/v1"
env_key = "DS_ROUTER_KEY"
wire_api = "responses"
```

Then, once per machine:

```powershell
setx DS_ROUTER_KEY "any-non-empty-value"
```

Open a **new** terminal and start `codex` while the router is running.

Notes:

- Recent Codex versions accept only `wire_api = "responses"`; `"chat"` was
  removed. The router implements the Responses wire format.
- If you leave `env_key` out, set `requires_openai_auth = false` in the
  provider block instead.
- Model ids are `deepseek-web` and `deepseek-web-thinking` (see
  `DEEPSEEK_MODELS`).
- The router must be running before Codex starts; otherwise Codex fails at the
  first request with a connection error.

## Tool calls (DSML bridging)

The web UI has no function-calling API, so the router:

1. appends every client tool schema to the prompt as a DSML contract;
2. buffers the response until it can tell whether a DSML block is starting;
3. parses `<｜｜DSML｜｜ calls> … </｜｜DSML｜｜ calls>` blocks, normalizes known
   malformed variants, and emits `function_call` output items;
4. feeds tool results back as a `[Tool result]` transcript on the next turn.

This is a heuristic text protocol, not a real tool API — see limitations.

## Native PoW helper

The JS solver works out of the box. For speed, build the C++ helper:

```bash
# in WSL
cd /path/to/repo
g++ -O3 -std=c++17 native/dps-pow.cpp -o ~/dps-router/dps-pow
```

The router looks for `dps-pow.exe` beside the source/root/native folder, then
for the WSL binary (override with `DPS_POW_WSL` / `DPS_POW_WSL_PATH`). Missing
helper = automatic JS fallback (much slower).

## Limitations

- **Unofficial private API.** Endpoint names, PoW algorithm, SSE frames and auth
  are reverse-engineered from the web app and can change without notice.
- **Account risk.** Automation may violate DeepSeek's terms of service and lead
  to throttling or account restrictions. Use your own account and accept the
  risk.
- **Session expiry.** Tokens last weeks at best; expiry surfaces as
  `401 session_expired`.
- **Rate limits are real.** DeepSeek throttles per account and sometimes signals
  it inside an HTTP 200 stream (`rate_limit_reached`). Heavy agent loops will hit
  cooldowns. Multi-account rotation helps only if you own the accounts.
- **Context is truncated.** Prompts longer than ~60,000 characters are cut to
  head + tail with a marker; anything in the middle is lost. This matters for
  very large agent transcripts.
- **DSML is text, not a schema.** Tool calls are parsed heuristically. Malformed
  blocks are repaired where possible, but very long parameter values can still
  arrive corrupted (a known failure mode when writing large files in one call).
  Prefer many small tool calls over one huge one.
- **No images, audio or file uploads.** Text only. Image inputs are rejected or
  ignored.
- **Thinking is consumed, not forwarded.** `THINK` fragments are used for
  diagnostics and empty-turn detection, not surfaced as reasoning items.
- **Web search results are not forwarded** as citations.
- **Sticky sessions are ephemeral.** Rotation (rate limit, empty turn) starts a
  new server-side conversation and loses prior web context; the router rebuilds
  it from the prompt it keeps client-side.
- **Buffered streaming.** To guarantee non-empty responses and DSML integrity,
  the router may buffer a full completion before emitting SSE; time-to-first
  token is worse than a native streaming API.
- **Single machine, single user.** No clustering, no persistence, no metrics
  beyond `/pool` and logs.
- **Not production software.** No SLA, no security review, no guarantees.

## Security

- `.env` holds live session credentials in plaintext. It is gitignored; never
  commit it, paste it into an issue, or share logs containing it.
- `ROUTER_API_KEY` only protects the loopback listener. Leave it empty only if
  every local process is trusted.
- `ALLOW_NON_LOOPBACK=true` exposes your DeepSeek session to the network.
  Don't.
- If a token leaks: log out of the DeepSeek web session (or change the password)
  and capture a new token.
- The router sends your prompts to `chat.deepseek.com`; treat content
  accordingly.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 session_expired` | Session token expired — capture a fresh bearer/cookie |
| `429 rate_limited` | Account throttled — wait for the cooldown, or add accounts |
| Empty answers | Router rotates the session and retries; check the log |
| Codex: `Missing environment variable DS_ROUTER_KEY` | `setx DS_ROUTER_KEY ...`, open a new terminal |
| Codex: `wire_api` error | Use `wire_api = "responses"` (chat was removed) |
| `EADDRINUSE` | Another router instance is running on the port |
| PoW slow (≈10 s) | Native helper missing — the JS solver is in use |
| Garbled tool arguments | Known DSML corruption; split large writes into small calls |

## Disclaimer

Not affiliated with DeepSeek or OpenAI. Provided as-is, without warranty of any
kind. You are responsible for how you use it and for complying with the terms of
service of any service it talks to.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import { createDeepSeekSession } from "./session.js";
import { createDeepSeekClient } from "./deepseek.js";
import { AccountPool, loadAccounts } from "./accounts.js";
import { handleChatCompletion, handleResponses, type ResponsesDeps } from "./responses.js";
import { HttpError } from "./errors.js";
import type { OpenAIChatRequest, RouterConfig } from "./types.js";

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request body too large", "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(error));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, {
      error: { message: error.message, type: "invalid_request_error", code: error.code },
    });
    return;
  }
  const message = error instanceof Error ? error.message : "internal error";
  sendJson(res, 500, { error: { message, type: "server_error", code: "internal" } });
}

function authorize(req: IncomingMessage, config: RouterConfig): boolean {
  if (!config.routerApiKey) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${config.routerApiKey}`;
}

function pipeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return Promise.resolve();
  }
  return response.body.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        res.write(Buffer.from(chunk));
      },
      close() {
        res.end();
      },
      abort() {
        res.end();
      },
    }),
  ).then(() => undefined);
}

export function createAppHandler(config: RouterConfig, deps: ResponsesDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!authorize(req, config)) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "auth_error", code: "unauthorized" } });
      return;
    }

    const conversationId = req.headers["x-conversation-id"]?.toString().slice(0, 128) || "default";

    try {
      if (req.method === "GET" && url.pathname === "/pool") {
        sendJson(res, 200, { accounts: deps.pool.stats() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: config.models.map((id) => ({
            id,
            object: "model",
            owned_by: "deepseek-web",
          })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(req, config.maxBodyBytes)) as OpenAIChatRequest;
        const response = await handleChatCompletion(body, deps, conversationId);
        await pipeResponse(res, response);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const body = JSON.parse(await readBody(req, config.maxBodyBytes)) as Record<string, unknown>;
        const response = await handleResponses(body, deps, conversationId);
        await pipeResponse(res, response);
        return;
      }

      sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
    } catch (error) {
      sendError(res, error);
    }
  };
}

// lightweight request logger
let reqCount = 0;
export function logRequest(note: string): void {
  reqCount++;
  console.log(`[req ${reqCount}] ${note}`);
}

export function main(): void {
  const config = loadConfig();
  if (!config.bearerToken && !config.userToken && !config.rawCookie) {
    console.error(
      "No DeepSeek session configured. Copy .env.example to .env and set DEEPSEEK_BEARER_TOKEN (required) plus DEEPSEEK_COOKIE.",
    );
    process.exit(1);
  }

  const session = createDeepSeekSession(config);
  const client = createDeepSeekClient(config, session);
  const accounts = loadAccounts(process.env, { bearerToken: config.bearerToken, cookie: config.rawCookie });
  const pool = new AccountPool(config, accounts, (cfg, acc) => {
    const scoped: RouterConfig = { ...cfg, bearerToken: acc.bearerToken, rawCookie: acc.cookie };
    return createDeepSeekSession(scoped);
  });
  const deps: ResponsesDeps = { config, client, session, pool, now: Date.now };
  const handler = createAppHandler(config, deps);

  const server = createServer((req, res) => {
    void handler(req, res);
  });

  server.listen(config.port, config.host, () => {
    console.log(`deepseek-web-router listening on http://${config.host}:${config.port}`);
    console.log(`models: ${config.models.join(", ")}`);
    console.log(`auth: ${config.routerApiKey ? "Bearer ROUTER_API_KEY" : "open (loopback only)"}`);
  });
}

main();

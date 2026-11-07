#!/usr/bin/env node
// Standalone FAKE OpenAI-compatible router for offline client smoke tests
// (e.g. Hermes in WSL). Listens on loopback only, holds NO credentials, makes
// NO outbound requests, and never touches a DeepSeek session.
//
// Usage: node tests/fake-router.mjs [port]     (default 20129)
// Optional: FAKE_ROUTER_KEY=<key> to require Bearer auth.
//
// Behavior mirrors the real router's contract:
//   GET  /health            -> { ok: true }
//   GET  /v1/models         -> catalog with deepseek-web / deepseek-web-thinking
//   POST /v1/chat/completions -> chat.completion (JSON) or chunk stream + [DONE]
//   POST /v1/responses      -> response (JSON) or Responses SSE events
// Requests carrying tools/tool_choice get the same 400 the real router gives
// the Chat path, so clients that cannot run text-only are exposed here first.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 20129);
const key = process.env.FAKE_ROUTER_KEY ?? "";
const models = ["deepseek-web", "deepseek-web-thinking"];
const replyText = "FAKE-ROUTER-OK: this is a canned offline response.";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function chatCompletionJson(model) {
  return {
    id: "chatcmpl-fake-1",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
  };
}

function chatChunk(id, delta, finishReason) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake-1",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function responsesJson(model) {
  return {
    id: "resp-fake-1",
    object: "response",
    status: "completed",
    model,
    output: [
      {
        id: "msg_0",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: replyText, annotations: [] }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function responsesStreamText(model) {
  return [
    sse("response.created", {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-fake-1", object: "response", status: "in_progress", model, output: [] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_0",
      output_index: 0,
      content_index: 0,
      delta: replyText,
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: {
        id: "msg_0",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: replyText, annotations: [] }],
      },
    }),
    sse("response.completed", {
      type: "response.completed",
      sequence_number: 4,
      response: { id: "resp-fake-1", object: "response", status: "completed", model, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    }),
  ].join("");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, fake: true });
    return;
  }

  if (key) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${key}`) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "auth_error", code: "unauthorized" } });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake-router" })) });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: { message: "invalid JSON", type: "invalid_request_error", code: "invalid_body" } });
      return;
    }
    const isChat = url.pathname === "/v1/chat/completions";
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    console.log(
      `[req] ${url.pathname} stream=${!!body.stream} model=${body.model ?? "?"} tools=${toolCount} msgs=${Array.isArray(body.messages) ? body.messages.length : Array.isArray(body.input) ? body.input.length : "?"}`,
    );
    const model = typeof body.model === "string" && body.model ? body.model : models[0];
    // FAKE_IGNORE_TOOLS=1 deviates from the real router contract on purpose:
    // it strips tools like the real /v1/responses bridge does, so clients that
    // always declare tools can still exercise the text wire format.
    const ignoreTools = process.env.FAKE_IGNORE_TOOLS === "1";
    if (!ignoreTools && (body.tools !== undefined || body.tool_choice !== undefined)) {
      // Same contract as the real router's Chat path.
      sendJson(res, 400, {
        error: { message: "DeepSeek web routing does not support tools or tool_choice", type: "invalid_request_error", code: "unsupported_feature" },
      });
      return;
    }
    if (isChat) {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(chatChunk(model, { role: "assistant", content: "" }, null));
        res.write(chatChunk(model, { content: replyText }, null));
        res.write(chatChunk(model, {}, "stop"));
        res.end("data: [DONE]\n\n");
      } else {
        sendJson(res, 200, chatCompletionJson(model));
      }
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(responsesStreamText(model));
    } else {
      sendJson(res, 200, responsesJson(model));
    }
    return;
  }

  sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-router listening on http://127.0.0.1:${port} (auth: ${key ? "Bearer FAKE_ROUTER_KEY" : "open"})`);
  console.log("canned reply:", replyText);
});

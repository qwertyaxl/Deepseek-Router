import type { OpenAIChatRequest, RouterConfig } from "./types.js";

import {

  buildDeepSeekBody,

  collectSseText,

  createDeepSeekClient,

  deltaFromPayload,

  normalizeJsonCompletion,

  type DeepSeekClient,

} from "./deepseek.js";

import { HttpError } from "./errors.js";

import type { DeepSeekSession } from "./session.js";

import { extractDsmlToolCalls, type DsmlToolCall } from "./deepseek.js";
import type { AccountPool } from "./accounts.js";

export interface ResponsesDeps {

  client: DeepSeekClient;

  session: DeepSeekSession;

  pool: AccountPool;

  config: RouterConfig;

  now?: () => number;

}

const encoder = new TextEncoder();

function isDefinitelyDsml(pending: string): boolean {

  return pending.includes("<\uFF5C\uFF5CDSML\uFF5C\uFF5C");

}

function resolveModel(requested: unknown, config: RouterConfig): string {

  const thinkingEntry = config.models.find((m) => m.includes("think"));

  const plainEntry = config.models.find((m) => !m.includes("think")) ?? config.models[0]!;

  const preferThinking = process.env.DEEPSEEK_THINKING_DEFAULT === "true";

  if (typeof requested === "string" && requested) {

    if (config.models.includes(requested)) {

      if (preferThinking && requested === plainEntry && thinkingEntry) return thinkingEntry;

      return requested;

    }

    return requested.toLowerCase().includes("think") ? thinkingEntry ?? plainEntry : plainEntry;

  }

  return preferThinking && thinkingEntry ? thinkingEntry : plainEntry;

}

function isThinkingModel(model: string, config: RouterConfig): boolean {

  return model.includes("thinking") && config.thinkingEnabled;

}

/** Convert Responses-API `input` (string or message array) into chat messages. */

function inputToMessages(input: unknown, instructions?: string): unknown {

  const messages: Array<{ role: string; content: string }> = [];

  if (instructions && typeof instructions === "string") {

    messages.push({ role: "system", content: instructions });

  }

  if (typeof input === "string") {

    messages.push({ role: "user", content: input });

    return messages;

  }

  if (!Array.isArray(input)) {

    throw new HttpError(400, "input must be a string or an array", "invalid_input");

  }

  for (const entry of input) {

    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;

    if (record.type === "function_call_output") {

      const output = typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? "");

      messages.push({ role: "assistant", content: `[Tool result]\n${output.slice(0, 8000)}` });

      continue;

    }

    if (record.type === "function_call") {

      const args = typeof record.arguments === "string" ? record.arguments : "{}";

      messages.push({

        role: "assistant",

        content: `[Tool call: ${String(record.name ?? "tool")}(${args.slice(0, 2000)})]`,

      });

      continue;

    }

    if (record.type && record.type !== "message") continue; // reasoning, etc.

    let role = typeof record.role === "string" ? record.role : "user";

    if (role === "developer") role = "system";

    if (role === "tool") role = "assistant";

    const content = record.content;

    if (typeof content === "string") {

      messages.push({ role, content });

      continue;

    }

    if (Array.isArray(content)) {

      const text = content

        .map((part) => {

          if (!part || typeof part !== "object") return "";

          const p = part as Record<string, unknown>;

          if (typeof p.text === "string") return p.text;

          if (p.type === "input_text" || p.type === "output_text") {

            return typeof p.text === "string" ? p.text : "";

          }

          return "";

        })

        .filter(Boolean)

        .join("");

      messages.push({ role, content: text });

    }

  }

  if (messages.length === 0) {

    throw new HttpError(400, "input contains no usable messages", "invalid_input");

  }

  return messages;

}

function sseEvent(event: string, payload: unknown): Uint8Array {

  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

}

/**

 * Translate a DeepSeek web SSE stream into an OpenAI Responses API event

 * stream (the wire format Codex consumes). Only the events Codex needs are

 * emitted: response.created, output item, output_text deltas, completed.

 */

/**
 * Buffered variant: build the full Responses SSE stream from an already-collected
 * completion (used after empty-turn auto-recovery on the streaming path).
 */
export function responsesStreamFromCollected(
  collected: { text: string; lastMessageId?: number | null; finished: boolean },
  model: string,
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const completionId = `resp-ds-${now()}`;
  let sequence = 0;
  const nextSeq = () => ++sequence;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const extracted = extractDsmlToolCalls(collected.text || "");
      const visible = extracted.cleanText;
      const toolCalls = extracted.toolCalls;
      const accumulated = visible;
      const sse = (event: string, data: Record<string, unknown>) =>
        new TextEncoder().encode(`event: ${event}
data: ${JSON.stringify(data)}

`);
      let itemStarted = false;
      if (accumulated) {
        itemStarted = true;
        controller.enqueue(sse("response.created", {
          type: "response.created",
          sequence_number: nextSeq(),
          response: { id: completionId, object: "response", status: "in_progress", model, output: [] },
        }));
        controller.enqueue(sse("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: 0,
          item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },
        }));
        controller.enqueue(sse("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: nextSeq(),
          item_id: "msg_0",
          output_index: 0,
          content_index: 0,
          delta: accumulated,
        }));
      }
      const outputItems: Record<string, unknown>[] = [];
      if (accumulated || !toolCalls.length) {
        outputItems.push({
          id: "msg_0", type: "message", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: accumulated, annotations: [] }],
        });
      }
      for (const call of toolCalls) {
        outputItems.push({
          id: call.callId, type: "function_call", name: call.name,
          arguments: JSON.stringify(call.arguments), call_id: call.callId, status: "completed",
        });
      }
      if (itemStarted) {
        controller.enqueue(sse("response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: nextSeq(),
          item_id: "msg_0",
          output_index: 0,
          content_index: 0,
          text: accumulated,
        }));
        controller.enqueue(sse("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: 0,
          item: { id: "msg_0", type: "message", status: "completed", role: "assistant",
                  content: [{ type: "output_text", text: accumulated, annotations: [] }] },
        }));
      }
      let toolIndex = accumulated || !toolCalls.length ? 1 : 0;
      for (const call of toolCalls) {
        controller.enqueue(sse("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: toolIndex++,
          item: { id: call.callId, type: "function_call", name: call.name,
                  arguments: JSON.stringify(call.arguments), call_id: call.callId, status: "completed" },
        }));
      }
      controller.enqueue(sse("response.completed", {
        type: "response.completed",
        sequence_number: nextSeq(),
        response: {
          id: completionId, object: "response", status: "completed", model,
          output: outputItems,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }));
      controller.close();
    },
  });
}

export function responsesStream(

  upstream: ReadableStream<Uint8Array>,

  model: string,

  now: () => number = Date.now,

): ReadableStream<Uint8Array> {  const completionId = `resp-ds-${now()}`;

  let sequence = 0;

  let cancelled = false;

  let accumulated = "";

  const dsmlState = { pending: "", buffered: "", buffering: false };

  return new ReadableStream<Uint8Array>({

    async start(controller) {

      const reader = upstream.getReader();

      const decoder = new TextDecoder();

      let buffer = "";

      let itemStarted = false;

      let done = false;

      const deltaState = { currentFragmentIsThink: false };

      const nextSeq = () => ++sequence;

      const finish = () => {

        if (done || cancelled) return;

        done = true;

        let toolCalls: DsmlToolCall[] = [];

        const tail = dsmlState.pending + dsmlState.buffered;

        if (tail) {

          const extracted = extractDsmlToolCalls(tail);

          toolCalls = extracted.toolCalls;

          const visible = dsmlState.buffering ? extracted.cleanText : tail;

          if (visible) {

            accumulated += visible;

            if (!itemStarted) {

              itemStarted = true;

              controller.enqueue(sseEvent("response.created", {

                type: "response.created",

                sequence_number: nextSeq(),

                response: { id: completionId, object: "response", status: "in_progress", model, output: [] },

              }));

              controller.enqueue(sseEvent("response.output_item.added", {

                type: "response.output_item.added",

                sequence_number: nextSeq(),

                output_index: 0,

                item: { id: "msg_0", type: "message", status: "in_progress", role: "assistant", content: [] },

              }));

            }

            controller.enqueue(sseEvent("response.output_text.delta", {

              type: "response.output_text.delta",

              sequence_number: nextSeq(),

              item_id: "msg_0",

              output_index: 0,

              content_index: 0,

              delta: visible,

            }));

          }

        }

        const outputItems: Record<string, unknown>[] = [];

        if (accumulated || !toolCalls.length) {

          outputItems.push({

            id: "msg_0",

            type: "message",

            status: "completed",

            role: "assistant",

            content: [{ type: "output_text", text: accumulated, annotations: [] }],

          });

        }

        for (const call of toolCalls) {

          outputItems.push({

            id: call.callId,

            type: "function_call",

            name: call.name,

            arguments: JSON.stringify(call.arguments),

            call_id: call.callId,

          });

        }

        if (itemStarted) {

          controller.enqueue(

            sseEvent("response.output_text.done", {

              type: "response.output_text.done",

              sequence_number: nextSeq(),

              item_id: "msg_0",

              output_index: 0,

              content_index: 0,

            }),

          );

          controller.enqueue(

            sseEvent("response.output_item.done", {

              type: "response.output_item.done",

              sequence_number: nextSeq(),

              output_index: 0,

              item: {

                id: "msg_0",

                type: "message",

                status: "completed",

                role: "assistant",

                content: [{ type: "output_text", text: accumulated, annotations: [] }],

              },

            }),

          );

        }

        let toolIndex = accumulated || !toolCalls.length ? 1 : 0;

        for (const call of toolCalls) {

          controller.enqueue(

            sseEvent("response.output_item.done", {

              type: "response.output_item.done",

              sequence_number: nextSeq(),

              output_index: toolIndex++,

              item: {

                id: call.callId,

                type: "function_call",

                name: call.name,

                arguments: JSON.stringify(call.arguments),

                call_id: call.callId,

                status: "completed",

              },

            }),

          );

        }

        controller.enqueue(

          sseEvent("response.completed", {

            type: "response.completed",

            sequence_number: nextSeq(),

            response: {

              id: completionId,

              object: "response",

              status: "completed",

              model,

              output: (() => {

                const items: Record<string, unknown>[] = [];

                if (accumulated || !toolCalls.length) {

                  items.push({

                    id: "msg_0",

                    type: "message",

                    status: "completed",

                    role: "assistant",

                    content: [{ type: "output_text", text: accumulated, annotations: [] }],

                  });

                }

                for (const call of toolCalls) {

                  items.push({

                    id: call.callId,

                    type: "function_call",

                    name: call.name,

                    arguments: JSON.stringify(call.arguments),

                    call_id: call.callId,

                    status: "completed",

                  });

                }

                return items;

              })(),

              usage: {

                input_tokens: 0,

                output_tokens: 0,

                total_tokens: 0,

              },

            },

          }),

        );

        controller.close();

      };

      const processLine = (line: string) => {

        if (done || cancelled) return;

        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) return;

        const raw = trimmed.slice(5).trim();

        if (!raw || raw === "[DONE]") {

          if (raw === "[DONE]") finish();

          return;

        }

        let text = "";

        try {

          const delta = deltaFromPayload(raw, deltaState);

          text = delta.text;

          if (text) {

            if (dsmlState.buffering) {

              dsmlState.buffered += text;

              return;

            }

            const low = dsmlState.pending + text;

            if (isDefinitelyDsml(low)) {

              dsmlState.buffering = true;

              dsmlState.buffered = low;

              dsmlState.pending = "";

              return;

            }

            if (low.includes("<") && low.length < 64 && !low.includes(">")) {

              dsmlState.pending = low;

              return;

            }

            text = low;

            dsmlState.pending = "";

          }

          // thinking deltas are intentionally not forwarded to the Responses

          // stream; Codex expects either reasoning items or text, and mixing

          // them without proper reasoning item ids breaks the client.

        } catch (error) {

          // Upstream error frame: surface it as a failed response event and stop.

          const message = error instanceof Error ? error.message : "upstream error";

          console.error("[responsesStream] upstream frame error:", message);

          controller.enqueue(

            sseEvent("response.failed", {

              type: "response.failed",

              sequence_number: nextSeq(),

              response: {

                id: completionId,

                object: "response",

                status: "failed",

                model,

                error: { code: "upstream_error", message },

              },

            }),

          );

          done = true;

          controller.close();

          return;

        }

        if (!text) return;

        accumulated += text;

        if (!itemStarted) {

          itemStarted = true;

          controller.enqueue(

            sseEvent("response.created", {

              type: "response.created",

              sequence_number: nextSeq(),

              response: {

                id: completionId,

                object: "response",

                status: "in_progress",

                model,

                output: [],

              },

            }),

          );

          controller.enqueue(

            sseEvent("response.output_item.added", {

              type: "response.output_item.added",

              sequence_number: nextSeq(),

              output_index: 0,

              item: {

                id: "msg_0",

                type: "message",

                status: "in_progress",

                role: "assistant",

                content: [],

              },

            }),

          );

          controller.enqueue(

            sseEvent("response.content_part.added", {

              type: "response.content_part.added",

              sequence_number: nextSeq(),

              item_id: "msg_0",

              output_index: 0,

              content_index: 0,

              part: { type: "output_text", text: "", annotations: [] },

            }),

          );

        }

        controller.enqueue(

          sseEvent("response.output_text.delta", {

            type: "response.output_text.delta",

            sequence_number: nextSeq(),

            item_id: "msg_0",

            output_index: 0,

            content_index: 0,

            delta: text,

          }),

        );

      };

      try {

        while (true) {

          const { done: upstreamDone, value } = await reader.read();

          if (upstreamDone) break;

          if (cancelled) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split(/\r?\n/);

          buffer = lines.pop() ?? "";

          for (const line of lines) processLine(line);

        }

        buffer += decoder.decode();

        if (buffer) processLine(buffer);

        finish();

      } catch (error) {

        if (!cancelled) {

          const message = error instanceof Error ? error.message : "stream error";

          console.error("[responsesStream] stream error:", message);

          controller.enqueue(

            sseEvent("response.failed", {

              type: "response.failed",

              sequence_number: nextSeq(),

              response: {

                id: completionId,

                object: "response",

                status: "failed",

                model,

                error: { code: "stream_error", message },

              },

            }),

          );

          controller.close();

        }

      } finally {

        reader.releaseLock();

      }

    },

    cancel() {

      cancelled = true;

    },

  });

}

export async function handleChatCompletion(

  body: OpenAIChatRequest,

  deps: ResponsesDeps,

  conversationId = "default",

): Promise<Response> {

  const { config, client, now = Date.now } = deps;

  // Unknown model ids (e.g. a stale default in a client config) are mapped to

  // the catalog: any id containing "think" maps to the thinking entry, others

  // to the plain entry. 404 is reserved for genuinely empty catalogs.

  const requestedModel = resolveModel(body.model, config);
  console.error(`[handleChatCompletion] resolved=${requestedModel}`);

  const turn = await deps.pool.pick(conversationId);

  const dsBody = buildDeepSeekBody(body, turn.chatSessionId, isThinkingModel(requestedModel, config), turn.parentMessageId);

  const upstream = await client.streamCompletion(dsBody);

  if (!upstream.ok || !upstream.body) {

    const detail = upstream.body ? await (upstream.body as unknown as { text(): Promise<string> }).text().catch(() => "") : "";

    throw new HttpError(

      upstream.status === 401 || upstream.status === 403 ? 401 : 502,

      `DeepSeek upstream failed: HTTP ${upstream.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,

      "upstream_error",

    );

  }

  if (body.stream) {

    // Buffer-first streaming: collect fully, run empty-turn auto-recovery, then
    // re-emit as SSE. Forwards an empty upstream never.
    let collected = await collectSseText(upstream.body as ReadableStream<Uint8Array>);

    if (collected.rateLimited) {

      deps.pool.markRateLimited(turn.state);

      throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");

    }

    if (collected.text.length === 0 && collected.thinking.length === 0) {

      const rotated = await deps.pool.rotateConversation(turn.state, conversationId);

      const retryBody = buildDeepSeekBody(body, rotated.chatSessionId, isThinkingModel(requestedModel, config), rotated.parentMessageId);

      const retryUpstream = await client.streamCompletion(retryBody);

      if (retryUpstream.ok && retryUpstream.body) {

        collected = await collectSseText(retryUpstream.body as ReadableStream<Uint8Array>);

      }

    }

    deps.pool.setLastMessageId(turn.state, conversationId, collected.lastMessageId);

    return new Response(responsesStreamFromCollected(collected, requestedModel, now), {

      status: 200,

      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },

    });

  }

  let result = await collectSseText(upstream.body as ReadableStream<Uint8Array>);

  if (result.rateLimited) {
    deps.pool.markRateLimited(turn.state);
    throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
  }

  // Empty-turn auto-recovery: rotate the web chat session once and retry.
  if (result.text.length === 0 && result.thinking.length === 0) {
    const rotated = await deps.pool.rotateConversation(turn.state, conversationId);
    const retryBody = buildDeepSeekBody(body, rotated.chatSessionId, isThinkingModel(requestedModel, config), rotated.parentMessageId);
    const retryUpstream = await client.streamCompletion(retryBody);
    if (retryUpstream.ok && retryUpstream.body) {
      result = await collectSseText(retryUpstream.body as ReadableStream<Uint8Array>);
      deps.pool.setLastMessageId(turn.state, conversationId, result.lastMessageId);
    }
  }

  deps.pool.setLastMessageId(turn.state, conversationId, result.lastMessageId);

  return Response.json(normalizeJsonCompletion(result, requestedModel, now));

}

export async function handleResponses(

  body: Record<string, unknown>,

  deps: ResponsesDeps,

  conversationId = "default",

): Promise<Response> {

  const { config, client, now = Date.now } = deps;

  const requestedModel = resolveModel(body.model, config);
  console.error(`[handleChatCompletion] resolved=${requestedModel}`);

  // Codex always declares its built-in tools (shell, apply_patch, ...).

  // DeepSeek web cannot execute them, so we strip the definitions instead of

  // rejecting the request — text-only chat still works and the model simply

  // answers in plain text (this mirrors the venice router's "tool block" fix).

  console.error(`[handleResponses] tools=${Array.isArray(body.tools) ? body.tools.length : "none"} stream=${body.stream} input_items=${Array.isArray(body.input) ? body.input.length : "str"}`);
  void body.tool_choice;

  // Tool bridge: Codex declares tools in the request, but DeepSeek web cannot

  // execute function calls natively. Inject the tool schemas into the prompt

  // and instruct the model to answer with DSML blocks, which this router

  // converts back into Responses-API function_call items.

  let extraSystem = "";

  const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : [];

  if (tools.length) {

    const defs = tools

      .map((tool) => {

        const fn = (tool.function ?? tool) as Record<string, unknown>;

        const name = String(fn.name ?? "tool");

        const params = JSON.stringify(fn.parameters ?? {});

        return `- ${name}: args JSON schema ${params}`;

      })

      .join("\n");

    extraSystem = [

      "You have access to the following tools in this environment:",

      defs,

      "",

      "To call a tool, output EXACTLY this format and nothing else after it:",

      '<｜｜DSML｜｜ calls>',

      '<｜｜DSML｜｜ invoke name="TOOL_NAME">',

      '<｜｜DSML｜｜ parameter name="PARAM">value</｜｜DSML｜｜ parameter>',

      '</｜｜DSML｜｜ invoke>',

      '</｜｜DSML｜｜ calls>',

      "",

      "Rules: emit at most one calls block per reply; parameters must match the schema names; do not wrap the block in code fences; after the block output nothing else. Wait for tool results before continuing.",

].join("\n");

  }

  const chatRequest: OpenAIChatRequest = {

    messages: inputToMessages(body.input, [typeof body.instructions === "string" ? body.instructions : "", extraSystem].filter(Boolean).join("\n\n")),

    stream: body.stream === true,

  };

  const turn = await deps.pool.pick(conversationId);

  const dsBody = buildDeepSeekBody(chatRequest, turn.chatSessionId, isThinkingModel(requestedModel, config), turn.parentMessageId);

  const upstream = await client.streamCompletion(dsBody);

  if (!upstream.ok || !upstream.body) {

    const detail = upstream.body ? await (upstream.body as unknown as { text(): Promise<string> }).text().catch(() => "") : "";

    throw new HttpError(

      upstream.status === 401 || upstream.status === 403 ? 401 : 502,

      `DeepSeek upstream failed: HTTP ${upstream.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,

      "upstream_error",

    );

  }

  if (body.stream === true) {

    // Buffer-first streaming: fully collect the upstream SSE so the empty-turn
    // auto-recovery can run BEFORE anything reaches the client. Codex treats a
    // completed response with no output items as a finished (empty) turn, so an
    // empty upstream stream must never be forwarded as-is.
    let collected = await collectSseText(upstream.body as ReadableStream<Uint8Array>);

    if (collected.rateLimited) {

      deps.pool.markRateLimited(turn.state);

      throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");

    }

    if (collected.text.length === 0 && collected.thinking.length === 0) {

      const rotated = await deps.pool.rotateConversation(turn.state, conversationId);

      const retryBody = buildDeepSeekBody(chatRequest, rotated.chatSessionId, isThinkingModel(requestedModel, config), rotated.parentMessageId);

      const retryUpstream = await client.streamCompletion(retryBody);

      if (retryUpstream.ok && retryUpstream.body) {

        collected = await collectSseText(retryUpstream.body as ReadableStream<Uint8Array>);

        if (collected.rateLimited) {

          deps.pool.markRateLimited(turn.state);

          throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");

        }

      }

    }

    deps.pool.setLastMessageId(turn.state, conversationId, collected.lastMessageId);

    return new Response(responsesStreamFromCollected(collected, requestedModel, now), {

      status: 200,

      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },

    });

  }

  let result = await collectSseText(upstream.body as ReadableStream<Uint8Array>);

  if (result.rateLimited) {
    deps.pool.markRateLimited(turn.state);
    throw new HttpError(429, "DeepSeek web throttled this account (rate_limit_reached)", "rate_limited");
  }

  // Empty-turn auto-recovery (responses path): rotate web session once and retry.
  if (result.text.length === 0 && result.thinking.length === 0) {
    const rotated = await deps.pool.rotateConversation(turn.state, conversationId);
    const retryBody = buildDeepSeekBody(chatRequest, rotated.chatSessionId, isThinkingModel(requestedModel, config), rotated.parentMessageId);
    const retryUpstream = await client.streamCompletion(retryBody);
    if (retryUpstream.ok && retryUpstream.body) {
      result = await collectSseText(retryUpstream.body as ReadableStream<Uint8Array>);
    }
  }

  deps.pool.setLastMessageId(turn.state, conversationId, result.lastMessageId);

  return Response.json({

    id: `resp-ds-${now()}`,

    object: "response",

    status: "completed",

    model: requestedModel,

    output: [

      {

        id: "msg_0",

        type: "message",

        status: "completed",

        role: "assistant",

        content: [{ type: "output_text", text: result.text, annotations: [] }],

      },

    ],

    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },

  });

}

/** Collect an upstream stream, auto-continuing truncated messages (web "Continue"). */
async function collectWithAutoContinue(
  upstream: Response,
  client: DeepSeekClient,
  chatSessionId: string,
  deps: ResponsesDeps,
  turn: { state: import("./accounts.js").AccountState },
  conversationId: string,
): Promise<{ result: import("./deepseek.js").CollectedCompletion; finalStream: ReadableStream<Uint8Array> | null }> {
  let stream = upstream.body!;
  let merged: import("./deepseek.js").CollectedCompletion | null = null;
  for (let hop = 0; hop < 4; hop++) {
    const partial = await collectSseText(stream);
    merged = merged
      ? {
          text: merged.text + partial.text,
          thinking: merged.thinking + partial.thinking,
          lastMessageId: partial.lastMessageId ?? merged.lastMessageId,
          finished: partial.finished,
        }
      : partial;
    if (merged.finished || merged.lastMessageId === null) break;
    // Message truncated: ask DeepSeek to continue it.
    const cont = await client.continueCompletion(chatSessionId, merged.lastMessageId);
    if (!cont.ok || !cont.body) break;
    stream = cont.body;
  }
  deps.pool.setLastMessageId(turn.state, conversationId, merged!.lastMessageId);
  deps.pool.markSuccess(turn.state);
  return { result: merged!, finalStream: null };
}

export function createDeps(

  config: RouterConfig,

  client: DeepSeekClient,

  session: DeepSeekSession,

  pool: AccountPool,

): ResponsesDeps {

  return { config, client, session, pool, now: Date.now };

}

export { createDeepSeekClient };


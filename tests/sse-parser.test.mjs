import test from "node:test";
import assert from "node:assert/strict";

const { deltaFromPayload, collectSseText } = await import("../src/deepseek.ts");

function newState() {
  return { currentFragmentIsThink: false, lastMessageId: undefined, finished: false };
}

test("APPEND frame with multiple fragments aggregates ALL of them in order", () => {
  const state = newState();
  const d = deltaFromPayload(
    JSON.stringify({
      p: "response/fragments",
      o: "APPEND",
      v: [
        { type: "THINK", content: "think-a" },
        { type: "RESPONSE", content: "resp-b" },
        { type: "RESPONSE", content: "resp-c" },
      ],
    }),
    state,
  );
  assert.equal(d.text, "resp-bresp-c");
  assert.equal(d.thinking, "think-a");
  // Mode ends on the LAST recognized fragment (RESPONSE).
  assert.equal(state.currentFragmentIsThink, false);
});

test("empty APPEND fragment still switches the active mode", () => {
  const state = newState();
  deltaFromPayload(
    JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "t1" }] }),
    state,
  );
  assert.equal(state.currentFragmentIsThink, true);
  // RESPONSE fragment with empty content: no text, but mode switches.
  const d = deltaFromPayload(
    JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "" }] }),
    state,
  );
  assert.equal(d.text, "");
  assert.equal(state.currentFragmentIsThink, false);
  // Following bare delta is now visible answer text.
  const d2 = deltaFromPayload(JSON.stringify({ v: "answer" }), state);
  assert.equal(d2.text, "answer");
  assert.equal(d2.thinking, "");
});

test("initial envelope WIP emits fragments and stays unfinished", () => {
  const state = newState();
  const d = deltaFromPayload(
    JSON.stringify({
      v: {
        response: {
          message_id: 42,
          status: "WIP",
          fragments: [
            { type: "THINK", content: "t" },
            { type: "RESPONSE", content: "hello" },
          ],
        },
      },
    }),
    state,
  );
  assert.equal(d.text, "hello");
  assert.equal(d.thinking, "t");
  assert.equal(state.lastMessageId, 42);
  assert.notEqual(state.finished, true);
});

test("initial envelope FINISHED marks the message done", () => {
  const state = newState();
  const d = deltaFromPayload(
    JSON.stringify({
      v: {
        response: {
          message_id: 7,
          status: "FINISHED",
          fragments: [{ type: "RESPONSE", content: "done" }],
        },
      },
    }),
    state,
  );
  assert.equal(d.text, "done");
  assert.equal(state.finished, true);
});

test("response/status FINISHED patch marks finished; other patches do not", () => {
  const state = newState();
  deltaFromPayload(JSON.stringify({ p: "response/status", o: "SET", v: "FINISHED" }), state);
  assert.equal(state.finished, true);
  const state2 = newState();
  deltaFromPayload(JSON.stringify({ p: "response/status", o: "SET", v: "WIP" }), state2);
  assert.notEqual(state2.finished, true);
});

test("metadata path-bearing patches are NOT answer text", () => {
  const state = newState();
  const d = deltaFromPayload(
    JSON.stringify({ p: "chat/title", o: "SET", v: "my chat title" }),
    state,
  );
  assert.equal(d.text, "");
  assert.equal(d.thinking, "");
  const d2 = deltaFromPayload(
    JSON.stringify({ p: "response/search_results", o: "SET", v: "http://example.com" }),
    state,
  );
  assert.equal(d2.text, "");
});

test("close event and [DONE] never mark a WIP message finished", () => {
  const state = newState();
  const d = deltaFromPayload(JSON.stringify({ event: "close" }), state);
  assert.equal(d.finishReason, "stop");
  assert.notEqual(state.finished, true);
});

test("malformed JSON is ignored", () => {
  const state = newState();
  const d = deltaFromPayload("{not json", state);
  assert.equal(d.text, "");
  assert.equal(d.thinking, "");
});

// ---- collectSseText ---------------------------------------------------------

function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

const envelope = (id, status, fragments) =>
  `data: ${JSON.stringify({
    v: { response: { message_id: id, status, fragments } },
  })}\n\n`;

test("collectSseText: full finished stream", async () => {
  const body = streamFromChunks([
    envelope(1, "WIP", [{ type: "RESPONSE", content: "Hel" }]),
    'data: {"v":"lo"}\n\n',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
  ]);
  const r = await collectSseText(body);
  assert.equal(r.text, "Hello");
  assert.equal(r.finished, true);
  assert.equal(r.lastMessageId, 1);
  assert.equal(r.rateLimited, false);
});

test("collectSseText: rate-limit hint frame detected structurally", async () => {
  const body = streamFromChunks([
    'data: {"type":"error","content":"Messages too frequent, please retry","finish_reason":"rate_limit_reached"}\n\n',
  ]);
  const r = await collectSseText(body);
  assert.equal(r.rateLimited, true);
  // The error content must not leak into the answer text.
  assert.equal(r.text, "");
});

test("collectSseText: answer text MENTIONING rate limits is not a throttle", async () => {
  const body = streamFromChunks([
    envelope(2, "WIP", [{ type: "RESPONSE", content: "" }]),
    'data: {"v":"The API returned rate_limit_reached to me."}\n\n',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
  ]);
  const r = await collectSseText(body);
  assert.equal(r.rateLimited, false);
  assert.equal(r.text, "The API returned rate_limit_reached to me.");
  assert.equal(r.finished, true);
});

test("collectSseText: stream cut mid-message leaves finished=false", async () => {
  const body = streamFromChunks([
    envelope(3, "WIP", [{ type: "RESPONSE", content: "part" }]),
    'data: {"event":"close"}\n\n',
  ]);
  const r = await collectSseText(body);
  assert.equal(r.text, "part");
  assert.equal(r.finished, false);
  assert.equal(r.lastMessageId, 3);
});

test("collectSseText: chunk splits (CRLF, no trailing newline, mid-UTF8) still parse", async () => {
  const full =
    envelope(4, "WIP", [{ type: "RESPONSE", content: "ünïcodé" }]) +
    'data: {"v":" tail"}\n\n' +
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n';
  const bytes = new TextEncoder().encode(full);
  // Byte offset of the multibyte 'ü' (0xC3 0xBC) so a split can land mid-codepoint.
  const ubyte = new TextEncoder().encode(full.slice(0, full.indexOf("ü"))).length;
  const splits = [1, 9, ubyte, ubyte + 1, ubyte + 2, bytes.length - 3, bytes.length - 1];
  for (const at of splits) {
    const chunks = [bytes.slice(0, at), bytes.slice(at)];
    const r = await collectSseText(streamFromChunks(chunks));
    assert.equal(r.text, "ünïcodé tail", `split at ${at}`);
    assert.equal(r.finished, true, `split at ${at}`);
  }
  // CRLF line endings.
  const r2 = await collectSseText(streamFromChunks([full.replace(/\n/g, "\r\n")]));
  assert.equal(r2.text, "ünïcodé tail");
  // No trailing newline after the last data line.
  const r3 = await collectSseText(
    streamFromChunks([
      envelope(4, "WIP", [{ type: "RESPONSE", content: "ünïcodé" }]) +
        'data: {"v":" tail"}\n\n' +
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
    ]),
  );
  assert.equal(r3.finished, true);
  assert.equal(r3.text, "ünïcodé tail");
});

// ---- Captured live protocol (thinking model, 2026-11-07) --------------------
// Content arrives BOTH as path-addressed appends and inside full-state list
// updates; the parser must emit each character exactly once.

test("live protocol: path appends + full-state update + -1/content assemble PONG", () => {
  const state = newState();
  // envelope carries the first THINK fragment (already has partial content)
  const d0 = deltaFromPayload(
    JSON.stringify({
      v: { response: { message_id: 2, parent_id: 1, status: "WIP", fragments: [{ type: "THINK", content: "The" }] } },
    }),
    state,
  );
  assert.equal(d0.thinking, "The");
  assert.equal(d0.text, "");
  // path-addressed append to the last (THINK) fragment
  const d1 = deltaFromPayload(
    JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: " user" }),
    state,
  );
  assert.equal(d1.thinking, " user");
  // bare deltas also land in the THINK fragment
  const d2 = deltaFromPayload(JSON.stringify({ v: " wants" }), state);
  assert.equal(d2.thinking, " wants");
  // FULL state update re-carries THINK + starts RESPONSE with "P":
  // only the un-emitted suffixes are new (THINK suffix = everything after "The", RESPONSE = "P")
  const d3 = deltaFromPayload(
    JSON.stringify({
      p: "response/fragments",
      v: [
        { id: 2, type: "THINK", content: 'The user wants exactly "PONG". Simple.' },
        { id: 3, type: "RESPONSE", content: "P" },
      ],
    }),
    state,
  );
  // " user" and " wants" were already emitted (path append + bare delta),
  // so the full-state suffix only contributes the remainder.
  assert.equal(d3.thinking, ' exactly "PONG". Simple.');
  assert.equal(d3.text, "P");
  // -1/content now targets the last fragment = RESPONSE
  const d4 = deltaFromPayload(
    JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: "ONG" }),
    state,
  );
  assert.equal(d4.text, "ONG");
  // metadata paths still ignored
  const d5 = deltaFromPayload(
    JSON.stringify({ p: "response/fragments/-1/elapsed_secs", o: "SET", v: 0.57 }),
    state,
  );
  assert.equal(d5.text, "");
  assert.equal(d5.thinking, "");
  const d6 = deltaFromPayload(
    JSON.stringify({ p: "response", o: "BATCH", v: [{ p: "quasi_status", v: "FINISHED" }] }),
    state,
  );
  assert.equal(d6.text, "");
  // explicit finish
  deltaFromPayload(JSON.stringify({ p: "response/status", o: "SET", v: "FINISHED" }), state);
  assert.equal(state.finished, true);
});

test("live protocol: full collectSseText run over the captured frame sequence", async () => {
  const frames = [
    JSON.stringify({ request_message_id: 1, response_message_id: 2, model_type: "default" }),
    JSON.stringify({ v: { response: { message_id: 2, parent_id: 1, status: "WIP", fragments: [{ type: "THINK", content: "The" }] } } }),
    JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: " user" }),
    JSON.stringify({ v: " wants" }),
    JSON.stringify({ v: ' exactly "P' }),
    JSON.stringify({ v: 'ONG". Simple.' }),
    JSON.stringify({
      p: "response/fragments",
      v: [
        { id: 2, type: "THINK", content: 'The user wants exactly "PONG". Simple.' },
        { id: 3, type: "RESPONSE", content: "P" },
      ],
    }),
    JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: "ONG" }),
    JSON.stringify({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 65 }] }),
    JSON.stringify({ p: "response/status", o: "SET", v: "FINISHED" }),
  ];
  const body = streamFromChunks([frames.map((f) => `data: ${f}\n\n`).join("")]);
  const r = await collectSseText(body);
  assert.equal(r.text, "PONG");
  assert.equal(r.thinking, 'The user wants exactly "PONG". Simple.');
  assert.equal(r.finished, true);
  assert.equal(r.lastMessageId, 2);
});

test("live protocol: response delivered ONLY via full-state update", async () => {
  const state = newState();
  deltaFromPayload(
    JSON.stringify({ v: { response: { message_id: 9, status: "WIP", fragments: [] } } }),
    state,
  );
  const d = deltaFromPayload(
    JSON.stringify({
      p: "response/fragments",
      v: [
        { type: "THINK", content: "reasoning" },
        { type: "RESPONSE", content: "Answer text" },
      ],
    }),
    state,
  );
  assert.equal(d.thinking, "reasoning");
  assert.equal(d.text, "Answer text");
  // follow-up bare delta appends to the RESPONSE fragment
  const d2 = deltaFromPayload(JSON.stringify({ v: " more" }), state);
  assert.equal(d2.text, " more");
  assert.equal(d2.thinking, "");
});

import test from "node:test";
import assert from "node:assert/strict";

const { handleChatCompletion, handleResponses } = await import("../src/responses.ts");

// ---- fakes ------------------------------------------------------------------

function makeUpstream(sseText, status = 200) {
  const bytes = new TextEncoder().encode(sseText);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  return new Response(stream, { status });
}

/** Scripted DeepSeekClient: completions consumed in order, then continuations. */
function fakeClient({ completions = [], continues = [] } = {}) {
  const calls = { completion: [], cont: [] };
  let ci = 0;
  let gi = 0;
  return {
    calls,
    async streamCompletion(body) {
      calls.completion.push(body);
      const item = completions[ci++];
      if (item === undefined) throw new Error("unexpected extra streamCompletion");
      if (item instanceof Error) throw item;
      if (typeof item === "number") return makeUpstream("http-error-body", item);
      return makeUpstream(item);
    },
    async continueCompletion(chatSessionId, messageId) {
      calls.cont.push({ chatSessionId, messageId });
      const item = continues[gi++];
      if (item === undefined) throw new Error("unexpected extra continueCompletion");
      if (typeof item === "number") return makeUpstream("http-error-body", item);
      return makeUpstream(item);
    },
  };
}

function fakePool() {
  const state = { id: "primary" };
  const log = { picked: 0, rotated: 0, rateLimited: 0, success: 0, lastMessageId: undefined };
  return {
    state,
    log,
    async pick() {
      log.picked++;
      return { state, chatSessionId: "sess-1", parentMessageId: null };
    },
    async rotateConversation() {
      log.rotated++;
      return { chatSessionId: "sess-rot", parentMessageId: null };
    },
    setLastMessageId(_st, _conv, id) {
      log.lastMessageId = id;
    },
    markRateLimited() {
      log.rateLimited++;
    },
    markSuccess() {
      log.success++;
    },
    markFailure() {},
    stats() {
      return [];
    },
  };
}

const config = {
  models: ["deepseek-web", "deepseek-web-thinking"],
  thinkingEnabled: true,
};

function makeDeps(client, pool) {
  return { client, session: {}, pool, config, now: Date.now };
}

// SSE frame builders
const env = (id, status, fragments) =>
  `data: ${JSON.stringify({ v: { response: { message_id: id, status, fragments } } })}\n\n`;
const frag = (type, content) => ({ type, content });
const finished = 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n';
const contFrag = (content) =>
  `data: ${JSON.stringify({
    p: "response/fragments",
    o: "APPEND",
    v: [{ type: "RESPONSE", content }],
  })}\n\n`;
const rateLimitHint =
  'data: {"type":"error","content":"Messages too frequent","finish_reason":"rate_limit_reached"}\n\n';

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(block)[1]);
      return { event, data };
    });
}

const responsesReq = (extra = {}) => ({ model: "deepseek-web", input: "hi", ...extra });
const chatReq = (extra = {}) => ({
  model: "deepseek-web",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

// ---- /v1/responses ----------------------------------------------------------

test("responses non-streaming: finished stream, zero continuations", async () => {
  const client = fakeClient({
    completions: [env(1, "WIP", [frag("RESPONSE", "Hello")]) + finished],
  });
  const pool = fakePool();
  const res = await handleResponses(responsesReq(), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, "response");
  assert.equal(json.output[0].content[0].text, "Hello");
  assert.equal(client.calls.cont.length, 0);
  assert.equal(pool.log.lastMessageId, 1);
  assert.equal(pool.log.success, 1);
});

test("responses streaming: WIP truncated -> one continuation -> merged once", async () => {
  const client = fakeClient({
    completions: [env(10, "WIP", [frag("RESPONSE", "Par")]) + 'data: {"v":"tial"}\n\n'],
    continues: [contFrag(" answer") + finished],
  });
  const pool = fakePool();
  const res = await handleResponses(responsesReq({ stream: true }), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const text = await res.text();
  // The merged answer is emitted exactly once as a delta (no duplication from
  // the continuation hop).
  const deltas = parseSse(text).filter((e) => e.event === "response.output_text.delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].data.delta, "Partial answer");
  const completed = parseSse(text).find((e) => e.event === "response.completed");
  assert.equal(completed.data.response.output[0].content[0].text, "Partial answer");
  assert.deepEqual(client.calls.cont, [{ chatSessionId: "sess-1", messageId: 10 }]);
  assert.equal(pool.log.lastMessageId, 10);
});

test("responses: continuation budget stops at 3 and errors instead of pretending", async () => {
  const client = fakeClient({
    completions: [env(10, "WIP", [frag("RESPONSE", "a")])],
    continues: [contFrag("b"), contFrag("c"), contFrag("d"), contFrag("e-should-never-send")],
  });
  const pool = fakePool();
  await assert.rejects(
    handleResponses(responsesReq(), makeDeps(client, pool)),
    (err) => err.status === 502 && err.code === "incomplete_completion",
  );
  assert.equal(client.calls.cont.length, 3);
  assert.equal(pool.log.success, 0);
});

test("responses: failed continuation HTTP 500 -> 502 incomplete_completion", async () => {
  const client = fakeClient({
    completions: [env(11, "WIP", [frag("RESPONSE", "abc")])],
    continues: [500],
  });
  const pool = fakePool();
  await assert.rejects(
    handleResponses(responsesReq(), makeDeps(client, pool)),
    (err) => err.status === 502 && err.code === "incomplete_completion",
  );
  assert.equal(pool.log.success, 0);
});

test("responses: rate limit on a continuation hop -> 429 + account cooldown", async () => {
  const client = fakeClient({
    completions: [env(12, "WIP", [frag("RESPONSE", "abc")])],
    continues: [rateLimitHint],
  });
  const pool = fakePool();
  await assert.rejects(
    handleResponses(responsesReq(), makeDeps(client, pool)),
    (err) => err.status === 429 && err.code === "rate_limited",
  );
  assert.equal(pool.log.rateLimited, 1);
});

test("responses: empty turn -> rotate once -> retry succeeds", async () => {
  const client = fakeClient({
    completions: [
      env(5, "WIP", []), // heartbeat-style empty stream
      env(6, "WIP", [frag("RESPONSE", "Hello after rotation")]) + finished,
    ],
  });
  const pool = fakePool();
  const res = await handleResponses(responsesReq(), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.output[0].content[0].text, "Hello after rotation");
  assert.equal(pool.log.rotated, 1);
  assert.equal(pool.log.lastMessageId, 6);
  assert.equal(client.calls.completion[1].chat_session_id, "sess-rot");
});

test("responses: empty turn twice -> 502 empty_completion (never a silent success)", async () => {
  const client = fakeClient({
    completions: [env(5, "WIP", []), env(6, "WIP", [])],
  });
  const pool = fakePool();
  await assert.rejects(
    handleResponses(responsesReq(), makeDeps(client, pool)),
    (err) => err.status === 502 && err.code === "empty_completion",
  );
  assert.equal(pool.log.rotated, 1);
  assert.equal(pool.log.success, 0);
});

test("responses streaming: DSML tool call split across a continuation parses once", async () => {
  const part1 =
    'Let me check.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="shell">\n<｜｜DSML｜｜ parameter name="command">ls';
  const part2 = " -la</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
  const client = fakeClient({
    completions: [env(20, "WIP", [frag("RESPONSE", part1)])],
    continues: [contFrag(part2) + finished],
  });
  const pool = fakePool();
  const res = await handleResponses(responsesReq({ stream: true }), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const text = await res.text();
  const completed = parseSse(text).find((e) => e.event === "response.completed");
  const calls = completed.data.response.output.filter((item) => item.type === "function_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "shell");
  assert.equal(JSON.parse(calls[0].arguments).command, "ls -la");
  // The raw DSML tags must never leak into the visible text stream.
  assert.ok(!text.includes("DSML"));
});

// ---- /v1/chat/completions ---------------------------------------------------

test("chat non-streaming: chat.completion JSON with content", async () => {
  const client = fakeClient({
    completions: [env(30, "WIP", [frag("RESPONSE", "Hello")]) + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq(), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "Hello");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.equal(client.calls.cont.length, 0);
});

test("chat streaming: chat.completion.chunk deltas + [DONE], NOT Responses events", async () => {
  const client = fakeClient({
    completions: [env(31, "WIP", [frag("RESPONSE", "Hello")]) + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq({ stream: true }), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("response.created"), "Responses events leaked into chat stream");
  const chunks = text
    .split("\n\n")
    .filter((b) => b.trim() && b !== "data: [DONE]")
    .map((b) => JSON.parse(b.replace(/^data: /, "")));
  assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.content, "Hello");
  assert.equal(chunks[2].choices[0].finish_reason, "stop");
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("chat streaming: truncated WIP message auto-continues and merges", async () => {
  const client = fakeClient({
    completions: [env(32, "WIP", [frag("RESPONSE", "Hel")])],
    continues: [contFrag("lo") + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq({ stream: true }), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const text = await res.text();
  const chunks = text
    .split("\n\n")
    .filter((b) => b.trim() && b !== "data: [DONE]")
    .map((b) => JSON.parse(b.replace(/^data: /, "")));
  assert.equal(chunks[1].choices[0].delta.content, "Hello");
  assert.deepEqual(client.calls.cont, [{ chatSessionId: "sess-1", messageId: 32 }]);
});

test("chat non-streaming: empty turn twice -> 502 empty_completion", async () => {
  const client = fakeClient({
    completions: [env(40, "WIP", []), env(41, "WIP", [])],
  });
  const pool = fakePool();
  await assert.rejects(
    handleChatCompletion(chatReq(), makeDeps(client, pool)),
    (err) => err.status === 502 && err.code === "empty_completion",
  );
});

test("chat non-streaming: incomplete chain after budget -> 502 incomplete_completion", async () => {
  const client = fakeClient({
    completions: [env(50, "WIP", [frag("RESPONSE", "a")])],
    continues: [contFrag("b"), contFrag("c"), contFrag("d")],
  });
  const pool = fakePool();
  await assert.rejects(
    handleChatCompletion(chatReq(), makeDeps(client, pool)),
    (err) => err.status === 502 && err.code === "incomplete_completion",
  );
  assert.equal(client.calls.cont.length, 3);
});

test("chat: initial rate-limit hint -> 429 without a retry burst", async () => {
  const client = fakeClient({
    completions: [rateLimitHint],
  });
  const pool = fakePool();
  await assert.rejects(
    handleChatCompletion(chatReq(), makeDeps(client, pool)),
    (err) => err.status === 429 && err.code === "rate_limited",
  );
  assert.equal(pool.log.rateLimited, 1);
  assert.equal(client.calls.completion.length, 1);
});

// ---- Chat Completions tool bridge -------------------------------------------

const chatTools = [
  {
    type: "function",
    function: {
      name: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  },
];
const dsmlToolReply = [
  "Checking files.",
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="exec_command">',
  '<｜｜DSML｜｜ parameter name="cmd">dir</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

test("chat + tools: DSML reply becomes message.tool_calls with finish_reason tool_calls", async () => {
  const client = fakeClient({
    completions: [env(60, "WIP", [frag("RESPONSE", dsmlToolReply)]) + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq({ tools: chatTools }), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const json = await res.json();
  const choice = json.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, "Checking files.");
  assert.equal(choice.message.tool_calls.length, 1);
  assert.equal(choice.message.tool_calls[0].id, choice.message.tool_calls[0].id);
  assert.equal(choice.message.tool_calls[0].type, "function");
  assert.equal(choice.message.tool_calls[0].function.name, "exec_command");
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { cmd: "dir" });
  // The DSML contract was injected into the upstream prompt.
  assert.ok(client.calls.completion[0].prompt.includes("- exec_command: args JSON schema"));
  assert.ok(!choice.message.content.includes("DSML"));
});

test("chat + tools: plain text reply keeps finish_reason stop and no tool_calls", async () => {
  const client = fakeClient({
    completions: [env(61, "WIP", [frag("RESPONSE", "Just an answer.")]) + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq({ tools: chatTools }), makeDeps(client, pool));
  const json = await res.json();
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.equal(json.choices[0].message.content, "Just an answer.");
  assert.equal(json.choices[0].message.tool_calls, undefined);
});

test("chat: assistant tool_calls + role tool history flatten into the prompt", async () => {
  const client = fakeClient({
    completions: [env(62, "WIP", [frag("RESPONSE", "Done.")]) + finished],
  });
  const pool = fakePool();
  const body = {
    model: "deepseek-web",
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"dir"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file1\nfile2" },
    ],
  };
  const res = await handleChatCompletion(body, makeDeps(client, pool));
  assert.equal(res.status, 200);
  const prompt = client.calls.completion[0].prompt;
  assert.ok(prompt.includes("[Tool call: exec_command("));
  assert.ok(prompt.includes("[Tool result for call_1]"));
  assert.ok(prompt.includes("file1\nfile2"));
});

test("chat streaming: tool call emitted as delta.tool_calls then finish_reason tool_calls", async () => {
  const client = fakeClient({
    completions: [env(63, "WIP", [frag("RESPONSE", dsmlToolReply)]) + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq({ tools: chatTools, stream: true }), makeDeps(client, pool));
  assert.equal(res.status, 200);
  const text = await res.text();
  const chunks = text
    .split("\n\n")
    .filter((b) => b.trim() && b !== "data: [DONE]")
    .map((b) => JSON.parse(b.replace(/^data: /, "")));
  const toolChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
  assert.ok(toolChunk, "no delta.tool_calls chunk emitted");
  const tc = toolChunk.choices[0].delta.tool_calls[0];
  assert.equal(tc.index, 0);
  assert.equal(tc.function.name, "exec_command");
  assert.deepEqual(JSON.parse(tc.function.arguments), { cmd: "dir" });
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, "tool_calls");
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("responses + tools: contract injected, function_call still extracted", async () => {
  const client = fakeClient({
    completions: [env(64, "WIP", [frag("RESPONSE", dsmlToolReply)]) + finished],
  });
  const pool = fakePool();
  const res = await handleResponses(responsesReq({ tools: chatTools }), makeDeps(client, pool));
  const json = await res.json();
  const calls = json.output.filter((item) => item.type === "function_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "exec_command");
  assert.ok(client.calls.completion[0].prompt.includes("- exec_command: args JSON schema"));
});

test("chat + Hermes-style shell tool: declared param name 'command' is preserved", async () => {
  const shellTool = [
    {
      type: "function",
      function: {
        name: "shell",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
  ];
  const reply = [
    "Running it.",
    "<｜｜DSML｜｜ calls>",
    '<｜｜DSML｜｜ invoke name="shell">',
    '<｜｜DSML｜｜ parameter name="command">echo hi</｜｜DSML｜｜ parameter>',
    "</｜｜DSML｜｜ invoke>",
    "</｜｜DSML｜｜ calls>",
  ].join("\n");
  const client = fakeClient({
    completions: [env(70, "WIP", [frag("RESPONSE", reply)]) + finished],
  });
  const pool = fakePool();
  const res = await handleChatCompletion(chatReq({ tools: shellTool }), makeDeps(client, pool));
  const json = await res.json();
  const tc = json.choices[0].message.tool_calls[0];
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(JSON.parse(tc.function.arguments), { command: "echo hi" });
});

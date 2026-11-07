import test from "node:test";
import assert from "node:assert/strict";

const m = await import("../src/deepseek.ts");

test("DSML: variant closer '<｜｜DSML｜｜ /invoke>'", () => {
  const raw = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="shell">
<｜｜DSML｜｜ parameter name="command">ls -la</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ /invoke>
</｜｜DSML｜｜ calls>`;
  const r = m.extractDsmlToolCalls(raw);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "shell");
  // non-exec tools keep their declared parameter names (Hermes-style shell)
  assert.equal(r.toolCalls[0].arguments.command, "ls -la");
});

test("DSML: unclosed invoke salvage with params", () => {
  const raw =
    'Working.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="exec_command">\n<｜｜DSML｜｜ parameter name="cmd">dir</｜｜DSML｜｜ parameter>\n';
  const r = m.extractDsmlToolCalls(raw);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].arguments.cmd, "dir");
});

test("DSML: salvaged call with no params is dropped", () => {
  const raw =
    'Text\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="exec_command">\n</｜｜DSML｜｜ calls>';
  const r = m.extractDsmlToolCalls(raw);
  assert.deepEqual(r.toolCalls, []);
});

test("DSML: alias normalization command -> cmd", () => {
  const raw = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="command">echo hi</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
  const r = m.extractDsmlToolCalls(raw);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].arguments.cmd, "echo hi");
  assert.equal(r.toolCalls[0].arguments.command, undefined);
});

test("DSML: canonical block regression (cmd + boolean login)", () => {
  const raw = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="cmd" string="true">echo ok</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="login" string="false">true</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
  const r = m.extractDsmlToolCalls(raw);
  assert.equal(r.toolCalls[0].arguments.cmd, "echo ok");
  assert.equal(r.toolCalls[0].arguments.login, true);
});

test("DSML: param value containing quotes and percent vars", () => {
  const raw = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="cmd">node.exe "%APPDATA%\\CodeMetrics\\index.js" silent</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
  const r = m.extractDsmlToolCalls(raw);
  assert.ok(String(r.toolCalls[0].arguments.cmd).includes("%APPDATA%"));
  // Backslashes in the path must survive parsing verbatim.
  assert.equal(r.toolCalls[0].arguments.cmd, 'node.exe "%APPDATA%\\CodeMetrics\\index.js" silent');
});

// Bare closer '</｜｜DSML｜｜>' glued onto param value tails (field case 2026-10-19).
// String.raw keeps the Windows backslashes intact end-to-end.
test("DSML: bare-closer params recovered cleanly", () => {
  const raw = [
    "<｜｜DSML｜｜ calls>",
    '<｜｜DSML｜｜ invoke name="exec_command">',
    String.raw`<｜｜DSML｜｜ parameter name="cmd">Get-Content handout\authorization\README.md</｜｜DSML｜｜>`,
    String.raw`<｜｜DSML｜｜ parameter name="workdir">C:\ws\dark-pool-settlement</｜｜DSML｜｜>`,
    "<｜｜DSML｜｜ parameter name=\"yield_time_ms\">10000</｜｜DSML｜｜>",
    "</｜｜DSML｜｜>",
    "</｜｜DSML｜｜ calls>",
  ].join("\n");
  const r = m.extractDsmlToolCalls(raw);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].arguments.cmd, String.raw`Get-Content handout\authorization\README.md`);
  assert.equal(r.toolCalls[0].arguments.workdir, String.raw`C:\ws\dark-pool-settlement`);
  assert.equal(r.toolCalls[0].arguments.yield_time_ms, 10000);
});

// Field case 2026-10-20 (folded in from tests/field-case.mjs): merged boolean
// tail + workdir glued onto the cmd value.
test("DSML: merged param values split and workdir unglued", () => {
  const raw = [
    "<｜｜DSML｜｜ calls>",
    '<｜｜DSML｜｜ invoke name="exec_command">',
    String.raw`<｜｜DSML｜｜ parameter name="cmd" string="true">Get-Item solve.cpp; where.exe g++C:\Users\bryan\ws</｜｜DSML｜｜ parameter>`,
    String.raw`<｜｜DSML｜｜ parameter name="max_output_tokens" string="false">12000falsepowershell</｜｜DSML｜｜ parameter>`,
    "</｜｜DSML｜｜ invoke>",
    "</｜｜DSML｜｜ calls>",
  ].join("\n");
  const r = m.extractDsmlToolCalls(raw);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].arguments.cmd, "Get-Item solve.cpp; where.exe g++");
  assert.equal(r.toolCalls[0].arguments.workdir, String.raw`C:\Users\bryan\ws`);
  assert.equal(r.toolCalls[0].arguments.max_output_tokens, 12000);
  assert.equal(r.toolCalls[0].arguments.login, false);
  assert.equal(r.toolCalls[0].arguments.shell, "powershell");
});

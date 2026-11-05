const m = await import('../src/deepseek.ts');
// Test 1: variant closer '<｜｜DSML｜｜ /invoke>'
const t1 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="shell">
<｜｜DSML｜｜ parameter name="command">ls -la</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ /invoke>
</｜｜DSML｜｜ calls>`;
const r1 = m.extractDsmlToolCalls(t1);
console.log('T1 (variant closer):', r1.toolCalls.length === 1 && r1.toolCalls[0].arguments.cmd === 'ls -la' ? 'PASS' : 'FAIL', JSON.stringify(r1.toolCalls[0]?.arguments));

// Test 2: unclosed invoke salvage with params
const t2 = 'Working.\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="exec_command">\n<｜｜DSML｜｜ parameter name="cmd">dir</｜｜DSML｜｜ parameter>\n';
const r2 = m.extractDsmlToolCalls(t2);
console.log('T2 (unclosed salvage):', r2.toolCalls.length === 1 && r2.toolCalls[0].arguments.cmd === 'dir' ? 'PASS' : 'FAIL');

// Test 3: salvaged call with NO params should be dropped (missing cmd guard)
const t3 = 'Text\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="exec_command">\n</｜｜DSML｜｜ calls>';
const r3 = m.extractDsmlToolCalls(t3);
console.log('T3 (empty-arg drop):', r3.toolCalls.length === 0 ? 'PASS' : 'FAIL', JSON.stringify(r3.toolCalls));

// Test 4: alias normalization command->cmd
const t4 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="command">echo hi</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
const r4 = m.extractDsmlToolCalls(t4);
console.log('T4 (alias cmd):', r4.toolCalls[0]?.arguments.cmd === 'echo hi' ? 'PASS' : 'FAIL');

// Test 5: clean canonical (regression)
const t5 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="cmd" string="true">echo ok</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="login" string="false">true</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
const r5 = m.extractDsmlToolCalls(t5);
console.log('T5 (regression):', r5.toolCalls[0]?.arguments.cmd === 'echo ok' && r5.toolCalls[0]?.arguments.login === true ? 'PASS' : 'FAIL', JSON.stringify(r5.toolCalls[0]?.arguments));

// Test 6: param value containing quotes (shell command with quotes)
const t6 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="cmd">node.exe "%APPDATA%\CodeMetrics\index.js" silent</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
const r6 = m.extractDsmlToolCalls(t6);
console.log('T6 (quotes):', r6.toolCalls[0]?.arguments.cmd?.includes('%APPDATA%') ? 'PASS' : 'FAIL');

// Test 7: bare closer '</｜｜DSML｜｜>' glued onto param value tail (field case 2026-10-19)
{
  const raw = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="exec_command">',
    '<｜｜DSML｜｜ parameter name="cmd">Get-Content handout\authorization\README.md</｜｜DSML｜｜>',
    '<｜｜DSML｜｜ parameter name="workdir">C:\ws\dark-pool-settlement</｜｜DSML｜｜>',
    '<｜｜DSML｜｜ parameter name="yield_time_ms">10000</｜｜DSML｜｜>',
    '</｜｜DSML｜｜>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');
  const { toolCalls } = m.extractDsmlToolCalls(raw);
  const ok = toolCalls.length === 1
    && toolCalls[0].arguments.cmd === 'Get-Content handout\authorization\README.md'
    && toolCalls[0].arguments.workdir === 'C:\ws\dark-pool-settlement'
    && toolCalls[0].arguments.yield_time_ms === 10000;
  console.log(ok ? 'PASS 7: bare-closer params recovered cleanly' : 'FAIL 7: ' + JSON.stringify(toolCalls));
  if (!ok) process.exitCode = 1;
}

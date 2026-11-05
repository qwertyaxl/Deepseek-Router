const m = await import("file:///C:/Users/bryan/Documents/source_code/deepseek-web-router/src/deepseek.ts");
const raw = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="exec_command">',
  '<｜｜DSML｜｜ parameter name="cmd" string="true">Get-Item solve.cpp; where.exe g++C:\\Users\\bryan\\ws</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="max_output_tokens" string="false">12000falsepowershell</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");
const r = m.extractDsmlToolCalls(raw);
console.log("FIELD:", JSON.stringify(r.toolCalls[0]?.arguments));

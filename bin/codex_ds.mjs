#!/usr/bin/env node
// Launch Codex CLI pointed at the local deepseek-web-router.
// Usage: node bin/codex_ds.mjs [any codex args...]
//
// Env:
//   DS_ROUTER_PORT  - router port (default 20129)
//   DS_ROUTER_KEY   - ROUTER_API_KEY value if one is set in the router .env
//   DS_MODEL        - model id (default: deepseek-web)

import { spawn } from "node:child_process";

const port = process.env.DS_ROUTER_PORT ?? "20129";
const key = process.env.DS_ROUTER_KEY ?? "";
const model = process.env.DS_MODEL ?? "deepseek-web";

const args = [
  "--model", model,
  "-c", `model_provider=dsweb`,
  "-c", `model_providers.dsweb.name="DeepSeek Web Router"`,
  "-c", `model_providers.dsweb.base_url="http://127.0.0.1:${port}/v1"`,
  "-c", `model_providers.dsweb.wire_api="responses"`,
  "-c", `model_providers.dsweb.env_key=null`,
  ...(key ? ["-c", `model_providers.dsweb.requires_openai_auth=false`] : []),
  ...process.argv.slice(2),
];

const child = spawn("codex", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    // Codex requires *some* auth; satisfy the env_key check if configured.
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? (key || "local-router"),
  },
});

child.on("exit", (code) => process.exit(code ?? 0));

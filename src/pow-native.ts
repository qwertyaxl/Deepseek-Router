// DeepSeek PoW native solver bridge.
// Strategy: try a compiled helper binary first (dps-pow.exe next to this file or in
// router root), fall back to the JS solver in src/pow.ts if unavailable.
//
// Helper protocol (stdin/stdout, single line JSON):
//   in : {"challenge":"<64hex>","salt":"...","expire_at":123,"difficulty":144000}
//   out: {"answer":12345}
//
// Build (MSYS2/MinGW or MSVC): see build-native.md

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PowChallenge } from "./pow.js";

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(here, "dps-pow.exe"),
  join(here, "..", "dps-pow.exe"),
  join(here, "..", "native", "dps-pow.exe"),
];

// WSL fallback. Override for your own distro/user, e.g.
//   DPS_POW_WSL=//wsl.localhost/Ubuntu/home/<user>/dps-router/dps-pow
//   DPS_POW_WSL_PATH=/home/<user>/dps-router/dps-pow
const WSL_BINARY = process.env.DPS_POW_WSL || "//wsl.localhost/Ubuntu/home/axl/dps-router/dps-pow";
const WSL_BINARY_PATH = process.env.DPS_POW_WSL_PATH || "/home/axl/dps-router/dps-pow";
// Also accept a plain WSL invocation when the .exe build is unavailable.
let resolved: { exe: string; viaWsl: boolean; wslExe?: string } | null | undefined;

function helperPath(): { exe: string; viaWsl: boolean; wslExe?: string } | null {
  if (resolved !== undefined) return resolved;
  resolved = null;
  for (const p of CANDIDATES) {
    if (existsSync(p)) {
      resolved = { exe: p, viaWsl: false };
      return resolved;
    }
  }
  // Fall back to the WSL-built Linux binary (works from Git Bash / Windows host).
  if (existsSync(WSL_BINARY)) {
    resolved = { exe: WSL_BINARY, viaWsl: true, wslExe: WSL_BINARY_PATH };
  }
  return resolved;
}

export function nativeAvailable(): boolean {
  return helperPath() !== null;
}

/** Solve via the native helper; resolves null if the helper is missing or fails. */
export function nativeSolve(challenge: PowChallenge): Promise<number | null> {
  const helper = helperPath();
  if (!helper) return Promise.resolve(null);
  if (helper.viaWsl) {
    // wsl.exe stdin piping is unreliable from Node; use an temp file handoff.
    const dir = mkdtempSync(join(tmpdir(), "dspow-"));
    const inFile = join(dir, "in.json");
    const outFile = join(dir, "out.json");
    writeFileSync(
      inFile,
      JSON.stringify({ challenge: challenge.challenge, salt: challenge.salt, expire_at: challenge.expire_at, difficulty: challenge.difficulty }),
    );
    const BS = String.fromCharCode(92);
    const wslPath = (p: string) => "/mnt/" + (p[0] ?? "?").toLowerCase() + p.slice(2).split(BS).join("/");
    return new Promise((resolve) => {
      const child = spawn(
        "C:/Windows/System32/wsl.exe",
        ["bash", "-c", `${helper.wslExe ?? helper.exe} < ${wslPath(inFile)} > ${wslPath(outFile)}`],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 120_000);
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(readFileSync(outFile, "utf8").trim());
          resolve(typeof parsed.answer === "number" ? parsed.answer : null);
        } catch { resolve(null); }
        finally { try { unlinkSync(inFile); unlinkSync(outFile); } catch {} }
      });
    });
  }
  const exe = helper.exe;
  return new Promise((resolve) => {
    const child = spawn(exe, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 120_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "");
        resolve(typeof parsed.answer === "number" ? parsed.answer : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(
      JSON.stringify({
        challenge: challenge.challenge,
        salt: challenge.salt,
        expire_at: challenge.expire_at,
        difficulty: challenge.difficulty,
      }),
    );
  });
}

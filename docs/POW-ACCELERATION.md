# PoW acceleration notes

Every completion through this router has to solve a DeepSeek proof-of-work
challenge first. With the JavaScript solver that is the single biggest source of
latency; a native helper removes almost all of it.

## What the PoW actually is

`DeepSeekHashV1` (observed on `chat.deepseek.com`):

- SHA3-256 sponge, rate = 136 bytes, padding `0x06` + `0x80` at the end of the
  block;
- Keccak-f[1600] with **rounds 1..23 only** (round 0 is skipped — this is what
  makes it "custom");
- message = `salt + "_" + expire_at + "_" + n`;
- the target is an **exact 32-byte preimage**, not a threshold: find the first
  `n` in `[0, difficulty)` whose digest equals the challenge bytes;
- `difficulty` is a search bound (commonly 144000), not a numeric target.

Because it is an exact preimage, the only general strategy is brute force over
`n`; the win comes from doing that loop natively instead of in JS.

## The native helper

Source: `native/dps-pow.cpp` in this repository.

Protocol: one line of JSON on stdin, one line on stdout.

```json
{"challenge":"<64 hex>","salt":"...","expire_at":123,"difficulty":144000}
=> {"answer":12345}      // found
=> {"error":"unsolved"}  // bound exhausted
=> {"error":"bad input"} // malformed request
```

### Build

Linux / WSL (recommended on Windows — the router can call the WSL binary):

```bash
g++ -O3 -march=native -std=c++17 native/dps-pow.cpp -o ~/dps-router/dps-pow
```

Windows (MSYS2/MinGW or MSVC):

```bash
g++ -O3 -march=native -std=c++17 native/dps-pow.cpp -o native/dps-pow.exe
```

Use `-O3 -march=native` (optionally `-flto`). Do not ship debug builds: the
helper is called at least once per completion.

### Where the router looks for it

`src/pow-native.ts` tries, in order:

1. `dps-pow.exe` next to the compiled router sources;
2. `dps-pow.exe` in the repository root;
3. `native/dps-pow.exe`;
4. a WSL binary via the UNC path, default
   `//wsl.localhost/Ubuntu/home/<user>/dps-router/dps-pow`.

Override the WSL locations when your distro/user differs:

```bash
DPS_POW_WSL=//wsl.localhost/Ubuntu/home/<user>/dps-router/dps-pow
DPS_POW_WSL_PATH=/home/<user>/dps-router/dps-pow
```

If no helper is found, or it fails, the router silently falls back to the JS
solver in `src/pow.ts`.

### WSL performance notes

- Keep the binary **inside the WSL filesystem** (`/home/...`), not on `/mnt/c`.
  Launching from `/mnt/c` is measurably slower.
- The router does not pipe stdin into `wsl.exe` (unreliable from Node); it
  writes `in.json` and reads `out.json` from a temp directory. That handoff adds
  a few milliseconds — still far cheaper than solving in JS.
- Build once. Do not recompile or install toolchains per request.

## Observed timings

On the development machine (single core, warm cache):

| Solver | Per solve |
| --- | --- |
| JavaScript (`src/pow.ts`) | ~11.7 s |
| Native C++ (`-O3 -march=native`, WSL) | ~50–120 ms |

End-to-end for a simple completion: ~13 s with JS vs ~1.2 s with the native
helper. The solve is dominated by the brute-force loop, so it scales with
`difficulty` and with the position of the answer.

## Tuning checklist

1. `-O3 -march=native -std=c++17` (or `-flto`).
2. Binary in WSL home, not `/mnt/c`.
3. Confirm the helper is actually used: the router logs
   `[session] created web chat_session ...` and total request time drops to
   roughly one second.
4. If requests stay slow, the helper is missing or the WSL path is wrong —
   check `DPS_POW_WSL` / `DPS_POW_WSL_PATH` and that the binary is executable.
5. Do not lower `difficulty`; it comes from the server challenge. The bound is
   only the search limit.

## Caveats

- The helper is platform-specific. A Windows `.exe` does not run under WSL and
  vice versa; build for the platform that actually runs it.
- Binary artifacts are gitignored (`native/dps-pow`, `native/dps-pow.exe`).
  Keep sources in the repository and rebuild locally.
- This is an unofficial reverse-engineered scheme. If DeepSeek changes the hash,
  rounds, padding or message layout, the helper must be updated together with
  `src/pow.ts`.

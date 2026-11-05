// DeepSeekHashV1: SHA3-256 sponge (rate 136, pad 0x06|0x80) with Keccak-f[1600]
// rounds 1..23 only (round 0 skipped). Verified byte-exact against DeepSeek's
// own sha3_wasm_bg.wasm ("abc" -> f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506).
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1n, 3n, 6n, 10n, 15n, 21n, 28n, 36n, 45n, 55n, 2n, 14n, 27n, 41n, 56n, 8n, 25n, 43n, 62n, 18n, 39n, 61n, 20n, 44n];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const M = (1n << 64n) - 1n;
const rotl = (x: bigint, n: bigint): bigint => ((x << n) | (x >> (64n - n))) & M;

function keccakF(state: BigUint64Array, startRound: number): void {
  for (let r = startRound; r < 24; r++) {
    // theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c.push(state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1n);
      for (let y = 0; y < 25; y += 5) state[x + y] = state[x + y]! ^ d;
    }
    // rho + pi
    const t = state[1]!;
    const temp = BigUint64Array.from(state);
    let cur = t;
    for (let i = 0; i < 24; i++) {
      const j = PILN[i]!;
      const nxt = state[j]!;
      temp[j] = rotl(cur, ROTC[i]!);
      cur = nxt;
    }
    state.set(temp);
    // chi
    for (let y = 0; y < 25; y += 5) {
      const b = [state[y]!, state[y + 1]!, state[y + 2]!, state[y + 3]!, state[y + 4]!];
      for (let i = 0; i < 5; i++) state[y + i] = b[i]! ^ (~b[(i + 1) % 5]! & b[(i + 2) % 5]! & M);
    }
    // iota
    state[0] = state[0]! ^ RC[r]!;
  }
}

export function deepseekHashV1(msg: Uint8Array): string {
  const rate = 136;
  const state = new BigUint64Array(25);
  let off = 0;
  const absorb = (block: Uint8Array): void => {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) lane |= BigInt(block[i * 8 + j] ?? 0) << BigInt(8 * j);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state, 1);
  };
  while (off + rate <= msg.length) {
    absorb(msg.subarray(off, off + rate));
    off += rate;
  }
  const rem = msg.length - off;
  const block = new Uint8Array(rate);
  block.set(msg.subarray(off), 0);
  block[rem]! ^= 0x06;
  block[rate - 1]! |= 0x80;
  absorb(block);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    const lane = state[i] ?? 0n;
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((lane >> BigInt(8 * j)) & 0xffn);
  }
  return out.toString("hex");
}

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  target_path: string;
}

/**
 * DeepSeek PoW: find the first n in [0, difficulty) such that
 * DeepSeekHashV1(salt + "_" + expire_at + "_" + n) equals the 32 challenge
 * bytes exactly. Expected work ~ difficulty/2 hashes (~72k at difficulty
 * 144000; ~10-15s per solve in pure JS).
 */
export function solvePow(challenge: PowChallenge, maxAttempts?: number): number {
  if (challenge.algorithm && challenge.algorithm !== "DeepSeekHashV1") {
    throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}`);
  }
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const target = Buffer.from(challenge.challenge, "hex");
  const bound = Math.min(maxAttempts ?? challenge.difficulty, challenge.difficulty);
  for (let n = 0; n < bound; n++) {
    if (deepseekHashV1(Buffer.from(prefix + n, "utf8")) === target.toString("hex")) return n;
  }
  throw new Error(`PoW unsolved within ${bound} attempts`);
}

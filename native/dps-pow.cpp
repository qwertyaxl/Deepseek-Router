// DeepSeekHashV1 PoW solver — native helper.
// Hash: SHA3-256 sponge (rate 136, pad 0x06|0x80) with Keccak-f rounds 1..23 (round 0 skipped).
// Search: first n in [0, difficulty) with hash(salt + "_" + expire_at + "_" + n) == challenge bytes.
//
// Build (MSYS2 MinGW):  g++ -O3 -march=native -std=c++17 dps-pow.cpp -o dps-pow.exe
// Build (Linux):        g++ -O3 -march=native -std=c++17 dps-pow.cpp -o dps-pow

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <iostream>
#include <sstream>

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808AULL, 0x8000000080008000ULL,
    0x000000000000808BULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008AULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000AULL,
    0x000000008000808BULL, 0x800000000000008BULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800AULL, 0x800000008000000AULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL,
};
static const int ROTC[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
static const int PILN[24] = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};

static inline uint64_t rotl(uint64_t x, int n) { return (x << n) | (x >> (64 - n)); }

// Keccak-f[1600] rounds [startRound, 24)
static void keccakF(uint64_t st[25], int startRound) {
    uint64_t bc[5];
    for (int r = startRound; r < 24; r++) {
        for (int i = 0; i < 5; i++)
            bc[i] = st[i] ^ st[i+5] ^ st[i+10] ^ st[i+15] ^ st[i+20];
        for (int i = 0; i < 5; i++) {
            uint64_t t = bc[(i+4)%5] ^ rotl(bc[(i+1)%5], 1);
            for (int j = 0; j < 25; j += 5) st[i+j] ^= t;
        }
        uint64_t t = st[1];
        for (int i = 0; i < 24; i++) {
            int j = PILN[i];
            uint64_t tmp = st[j];
            st[j] = rotl(t, ROTC[i]);
            t = tmp;
        }
        for (int j = 0; j < 25; j += 5) {
            uint64_t b0=st[j], b1=st[j+1], b2=st[j+2], b3=st[j+3], b4=st[j+4];
            st[j]   = b0 ^ (~b1 & b2);
            st[j+1] = b1 ^ (~b2 & b3);
            st[j+2] = b2 ^ (~b3 & b4);
            st[j+3] = b3 ^ (~b4 & b0);
            st[j+4] = b4 ^ (~b0 & b1);
        }
        st[0] ^= RC[r];
    }
}

// DeepSeekHashV1: SHA3-256 sponge, rate 136, rounds 1..23
static void deepseekHashV1(const uint8_t* msg, size_t len, uint8_t out[32]) {
    const size_t rate = 136;
    uint64_t st[25] = {0};
    size_t off = 0;
    auto absorb = [&](const uint8_t* blk) {
        for (int i = 0; i < (int)(rate/8); i++) {
            uint64_t lane = 0;
            std::memcpy(&lane, blk + i*8, 8);
            st[i] ^= lane;
        }
        keccakF(st, 1);
    };
    while (off + rate <= len) { absorb(msg + off); off += rate; }
    uint8_t block[rate];
    std::memset(block, 0, rate);
    std::memcpy(block, msg + off, len - off);
    block[len-off] ^= 0x06;
    block[rate-1] ^= 0x80;
    absorb(block);
    for (int i = 0; i < 4; i++) std::memcpy(out + i*8, &st[i], 8);
}

static std::string hexToBytes(const std::string& hex) {
    std::string out;
    out.reserve(hex.size()/2);
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        int hi = nib(hex[i]), lo = nib(hex[i+1]);
        if (hi < 0 || lo < 0) return out;
        out.push_back((char)((hi << 4) | lo));
    }
    return out;
}

int main() {
    std::string line;
    std::getline(std::cin, line);
    // minimal JSON field extraction (values are trusted machine-generated)
    auto extract = [&](const char* key) -> std::string {
        std::string pat = std::string("\"") + key + "\":";
        size_t p = line.find(pat);
        if (p == std::string::npos) return "";
        p += pat.size();
        while (p < line.size() && line[p] == ' ') p++;
        if (line[p] == '"') {
            size_t e = line.find('"', p+1);
            return line.substr(p+1, e-p-1);
        }
        size_t e = line.find_first_of(",}", p);
        return line.substr(p, e-p);
    };

    std::string challengeHex = extract("challenge");
    std::string salt = extract("salt");
    std::string expireStr = extract("expire_at");
    std::string diffStr = extract("difficulty");
    if (challengeHex.empty() || salt.empty() || expireStr.empty()) {
        std::cout << "{\"error\":\"bad input\"}" << std::endl;
        return 1;
    }
    long long expireAt = atoll(expireStr.c_str());
    long long difficulty = diffStr.empty() ? 144000 : atoll(diffStr.c_str());
    std::string target = hexToBytes(challengeHex);

    std::string prefix = salt + "_" + expireStr + "_";
    std::vector<uint8_t> buf(prefix.begin(), prefix.end());
    buf.resize(prefix.size() + 24); // room for the decimal nonce

    uint8_t digest[32];
    for (long long n = 0; n < difficulty; n++) {
        int m = snprintf((char*)buf.data() + prefix.size(), 24, "%lld", n);
        deepseekHashV1(buf.data(), prefix.size() + m, digest);
        if (std::memcmp(digest, target.data(), 32) == 0) {
            std::cout << "{\"answer\":" << n << "}" << std::endl;
            return 0;
        }
    }
    std::cout << "{\"error\":\"unsolved\"}" << std::endl;
    return 2;
}

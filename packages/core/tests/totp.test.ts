import { describe, expect, it } from "vitest";
import { totp, hotp, secondsRemaining, matchTotpWindow } from "../src/totp.js";
import { base32Encode, base32Decode } from "../src/base32.js";

// RFC 6238 Appendix B test vectors (8-digit TOTP codes at T0=0, X=30s).
const SHA1_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const SHA256_SECRET = base32Encode(Buffer.from("12345678901234567890123456789012", "ascii"));
const SHA512_SECRET = base32Encode(
  Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii"),
);

const VECTORS: Array<{ time: number; sha1: string; sha256: string; sha512: string }> = [
  { time: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936" },
  { time: 1111111109, sha1: "07081804", sha256: "68084774", sha512: "25091201" },
  { time: 1111111111, sha1: "14050471", sha256: "67062674", sha512: "99943326" },
  { time: 1234567890, sha1: "89005924", sha256: "91819424", sha512: "93441116" },
  { time: 2000000000, sha1: "69279037", sha256: "90698825", sha512: "38618901" },
  { time: 20000000000, sha1: "65353130", sha256: "77737706", sha512: "47863826" },
];

describe("totp (RFC 6238 test vectors)", () => {
  for (const vector of VECTORS) {
    const timestamp = vector.time * 1000;

    it(`SHA1 @ T=${vector.time}`, () => {
      expect(totp({ secret: SHA1_SECRET, digits: 8, algorithm: "SHA1", timestamp })).toBe(vector.sha1);
    });

    it(`SHA256 @ T=${vector.time}`, () => {
      expect(totp({ secret: SHA256_SECRET, digits: 8, algorithm: "SHA256", timestamp })).toBe(vector.sha256);
    });

    it(`SHA512 @ T=${vector.time}`, () => {
      expect(totp({ secret: SHA512_SECRET, digits: 8, algorithm: "SHA512", timestamp })).toBe(vector.sha512);
    });
  }

  it("defaults to 6 digits and 30s period", () => {
    const code = totp({ secret: SHA1_SECRET, timestamp: 59_000 });
    expect(code).toHaveLength(6);
    // The 6-digit code is the last 6 digits of the 8-digit RFC vector.
    expect(code).toBe("94287082".slice(-6));
  });

  it("pads codes with leading zeros", () => {
    // Counter 0 with this secret is known to truncate to a small number.
    const code = hotp(Buffer.from("12345678901234567890", "ascii"), 0, { digits: 6 });
    expect(code).toHaveLength(6);
  });
});

describe("secondsRemaining", () => {
  it("counts down within a period and wraps at the boundary", () => {
    expect(secondsRemaining(30, 0)).toBe(30);
    expect(secondsRemaining(30, 1000)).toBe(29);
    expect(secondsRemaining(30, 29_000)).toBe(1);
    expect(secondsRemaining(30, 30_000)).toBe(30);
  });
});

describe("matchTotpWindow", () => {
  const secretB32 = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const secretBuffer = base32Decode(secretB32);
  const period = 30;
  const digits = 6;

  function codeForStep(step: number): string {
    return hotp(secretBuffer, step, { digits });
  }

  it("matches the exact current step", () => {
    const timestamp = 59_000; // step 1
    const step = matchTotpWindow(secretBuffer, codeForStep(1), { digits, period, timestamp });
    expect(step).toBe(1);
  });

  it("accepts a code from one step in the past (clock drift)", () => {
    const timestamp = 90_000; // step 3
    const step = matchTotpWindow(secretBuffer, codeForStep(2), { digits, period, timestamp });
    expect(step).toBe(2);
  });

  it("accepts a code from one step in the future (clock drift)", () => {
    const timestamp = 90_000; // step 3
    const step = matchTotpWindow(secretBuffer, codeForStep(4), { digits, period, timestamp });
    expect(step).toBe(4);
  });

  it("rejects a code two steps away (outside the default window)", () => {
    const timestamp = 90_000; // step 3
    const step = matchTotpWindow(secretBuffer, codeForStep(5), { digits, period, timestamp });
    expect(step).toBeNull();
  });

  it("rejects a code that does not match any step in the window", () => {
    const timestamp = 90_000;
    const step = matchTotpWindow(secretBuffer, "000000", { digits, period, timestamp });
    expect(step).toBeNull();
  });

  it("rejects a code of the wrong length without throwing", () => {
    const timestamp = 90_000;
    expect(() => matchTotpWindow(secretBuffer, "12345", { digits, period, timestamp })).not.toThrow();
    expect(matchTotpWindow(secretBuffer, "12345", { digits, period, timestamp })).toBeNull();
  });

  it("respects a custom driftSteps window", () => {
    const timestamp = 90_000; // step 3
    expect(matchTotpWindow(secretBuffer, codeForStep(5), { digits, period, timestamp, driftSteps: 2 })).toBe(5);
  });
});

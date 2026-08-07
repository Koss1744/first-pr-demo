import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, verifyApiKey } from "../src/crypto/apiKey.js";

describe("apiKey", () => {
  it("generates a key whose hash matches hashApiKey(key)", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key.startsWith("hofi_cp_")).toBe(true);
    expect(prefix).toBe(key.slice(0, 8));
    expect(hashApiKey(key)).toEqual(hash);
  });

  it("verifyApiKey accepts a matching hash and rejects a different one", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(verifyApiKey(hashApiKey(a.key), a.hash)).toBe(true);
    expect(verifyApiKey(hashApiKey(b.key), a.hash)).toBe(false);
  });

  it("generates unique keys across calls", () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey().key));
    expect(keys.size).toBe(20);
  });
});

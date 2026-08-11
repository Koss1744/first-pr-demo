import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateDek, unwrapDek, wrapDek } from "../src/crypto/envelope.js";

describe("envelope encryption", () => {
  const rootKey = randomBytes(32);
  const userId = "11111111-1111-1111-1111-111111111111";
  const otherUserId = "22222222-2222-2222-2222-222222222222";

  it("round-trips a DEK through wrap/unwrap", () => {
    const dek = generateDek();
    const wrapped = wrapDek(rootKey, dek, userId);
    expect(unwrapDek(rootKey, wrapped, userId)).toEqual(dek);
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const dek = generateDek();
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(dek, secret, userId);
    expect(decryptSecret(dek, encrypted, userId)).toBe(secret);
  });

  it("generates distinct DEKs and distinct ciphertexts across calls", () => {
    const dekA = generateDek();
    const dekB = generateDek();
    expect(dekA).not.toEqual(dekB);

    const encryptedA = encryptSecret(dekA, "SAMESECRET", userId);
    const encryptedB = encryptSecret(dekA, "SAMESECRET", userId);
    expect(encryptedA.secretCiphertext).not.toEqual(encryptedB.secretCiphertext);
  });

  it("fails to unwrap a DEK with the wrong root key", () => {
    const wrapped = wrapDek(rootKey, generateDek(), userId);
    expect(() => unwrapDek(randomBytes(32), wrapped, userId)).toThrow();
  });

  it("fails to unwrap a DEK bound to a different userId (AAD mismatch, row-swap protection)", () => {
    const wrapped = wrapDek(rootKey, generateDek(), userId);
    expect(() => unwrapDek(rootKey, wrapped, otherUserId)).toThrow();
  });

  it("fails to decrypt a secret bound to a different userId (AAD mismatch, row-swap protection)", () => {
    const dek = generateDek();
    const encrypted = encryptSecret(dek, "SECRET", userId);
    expect(() => decryptSecret(dek, encrypted, otherUserId)).toThrow();
  });

  it("detects tampering with the ciphertext", () => {
    const dek = generateDek();
    const encrypted = encryptSecret(dek, "SECRET", userId);
    const tamperedCiphertext = Buffer.from(encrypted.secretCiphertext);
    tamperedCiphertext[0] ^= 0xff;
    expect(() => decryptSecret(dek, { ...encrypted, secretCiphertext: tamperedCiphertext }, userId)).toThrow();
  });

  it("detects tampering with the auth tag", () => {
    const dek = generateDek();
    const encrypted = encryptSecret(dek, "SECRET", userId);
    const tamperedTag = Buffer.from(encrypted.secretTag);
    tamperedTag[0] ^= 0xff;
    expect(() => decryptSecret(dek, { ...encrypted, secretTag: tamperedTag }, userId)).toThrow();
  });
});

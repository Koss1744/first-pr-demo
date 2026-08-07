import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "hofi_cp_";

export interface GeneratedApiKey {
  /** The raw key - shown to the operator once, never stored. */
  key: string;
  /** sha256(key) - what actually gets stored in service_clients.api_key_hash. */
  hash: Buffer;
  /** First 8 chars of the raw key, safe to store/log for correlation without revealing the secret. */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}

export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/** Constant-time comparison of a freshly-hashed candidate key against a stored hash. */
export function verifyApiKey(candidateHash: Buffer, storedHash: Buffer): boolean {
  return candidateHash.length === storedHash.length && timingSafeEqual(candidateHash, storedHash);
}

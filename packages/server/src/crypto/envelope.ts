import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

interface Sealed {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * AES-256-GCM encrypt/decrypt with the row's user_id bound as additional
 * authenticated data (AAD): a ciphertext decrypted under the wrong userId
 * fails auth-tag verification instead of silently succeeding, so a
 * database-level row-swap between two users' records can't go undetected.
 */
function seal(key: Buffer, plaintext: Buffer, userId: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function unseal(key: Buffer, sealed: Sealed, userId: string): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAAD(Buffer.from(userId, "utf8"));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/** Generates a fresh 32-byte data encryption key (DEK) for one user's TOTP secret. */
export function generateDek(): Buffer {
  return randomBytes(32);
}

export interface WrappedDek {
  wrappedDek: Buffer;
  wrappedDekIv: Buffer;
  wrappedDekTag: Buffer;
}

/** Encrypts a DEK under the root key (KEK) selected by the caller's active kek_version. */
export function wrapDek(rootKey: Buffer, dek: Buffer, userId: string): WrappedDek {
  const { iv, tag, ciphertext } = seal(rootKey, dek, userId);
  return { wrappedDek: ciphertext, wrappedDekIv: iv, wrappedDekTag: tag };
}

/** Decrypts a wrapped DEK using the root key matching the row's stored kek_version. */
export function unwrapDek(rootKey: Buffer, wrapped: WrappedDek, userId: string): Buffer {
  return unseal(rootKey, { iv: wrapped.wrappedDekIv, tag: wrapped.wrappedDekTag, ciphertext: wrapped.wrappedDek }, userId);
}

export interface EncryptedSecret {
  secretCiphertext: Buffer;
  secretIv: Buffer;
  secretTag: Buffer;
}

/** Encrypts a base32 TOTP secret under its per-record DEK. */
export function encryptSecret(dek: Buffer, secret: string, userId: string): EncryptedSecret {
  const { iv, tag, ciphertext } = seal(dek, Buffer.from(secret, "utf8"), userId);
  return { secretCiphertext: ciphertext, secretIv: iv, secretTag: tag };
}

/** Decrypts a TOTP secret using its already-unwrapped DEK. */
export function decryptSecret(dek: Buffer, encrypted: EncryptedSecret, userId: string): string {
  return unseal(
    dek,
    { iv: encrypted.secretIv, tag: encrypted.secretTag, ciphertext: encrypted.secretCiphertext },
    userId,
  ).toString("utf8");
}

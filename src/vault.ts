import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Account } from "./otpauth.js";

const VAULT_VERSION = 1;
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface VaultFile {
  version: number;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface OpenVault {
  accounts: Account[];
  key: Buffer;
  salt: Buffer;
}

export function defaultVaultPath(): string {
  return process.env.HOFI_VAULT_PATH ?? join(homedir(), ".hofi-authenticator", "vault.json");
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

function encryptAccounts(key: Buffer, accounts: Account[]): { iv: Buffer; authTag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(accounts), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

function decryptAccounts(key: Buffer, file: VaultFile): Account[] {
  const iv = Buffer.from(file.iv, "base64");
  const authTag = Buffer.from(file.authTag, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Incorrect master password or corrupted vault");
  }

  return JSON.parse(plaintext.toString("utf8")) as Account[];
}

async function readVaultFile(path: string): Promise<VaultFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as VaultFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeVaultFile(path: string, file: VaultFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(tmpPath, path);
}

export async function vaultExists(path: string = defaultVaultPath()): Promise<boolean> {
  return (await readVaultFile(path)) !== null;
}

/** Creates a brand-new, empty vault protected by the given master password. */
export async function initVault(password: string, path: string = defaultVaultPath()): Promise<void> {
  const salt = randomBytes(16);
  const key = deriveKey(password, salt);
  const { iv, authTag, ciphertext } = encryptAccounts(key, []);
  await writeVaultFile(path, {
    version: VAULT_VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

/** Opens and decrypts the vault, returning the accounts plus the derived key/salt for re-saving. */
export async function openVault(password: string, path: string = defaultVaultPath()): Promise<OpenVault> {
  const file = await readVaultFile(path);
  if (!file) {
    throw new Error(`No vault found at ${path}. Run "hofi init" first.`);
  }
  const salt = Buffer.from(file.salt, "base64");
  const key = deriveKey(password, salt);
  const accounts = decryptAccounts(key, file);
  return { accounts, key, salt };
}

/** Re-encrypts the vault under a new master password, keeping the same accounts. */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
  path: string = defaultVaultPath(),
): Promise<void> {
  const { accounts } = await openVault(oldPassword, path);
  const newSalt = randomBytes(16);
  const newKey = deriveKey(newPassword, newSalt);
  await saveAccounts(accounts, newKey, newSalt, path);
}

/** Re-encrypts and persists the given accounts using an already-derived key/salt from openVault(). */
export async function saveAccounts(
  accounts: Account[],
  key: Buffer,
  salt: Buffer,
  path: string = defaultVaultPath(),
): Promise<void> {
  const { iv, authTag, ciphertext } = encryptAccounts(key, accounts);
  await writeVaultFile(path, {
    version: VAULT_VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

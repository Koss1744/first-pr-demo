import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changePassword, initVault, openVault, saveAccounts, vaultExists } from "../src/vault.js";
import type { Account } from "../src/otpauth.js";

let dir: string;
let vaultPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hofi-vault-test-"));
  vaultPath = join(dir, "vault.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sampleAccount: Account = {
  label: "alice@example.com",
  secret: "JBSWY3DPEHPK3PXP",
  issuer: "GitHub",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
};

describe("vault", () => {
  it("does not exist before init", async () => {
    expect(await vaultExists(vaultPath)).toBe(false);
  });

  it("creates an empty vault with restrictive file permissions", async () => {
    await initVault("hunter2", vaultPath);
    expect(await vaultExists(vaultPath)).toBe(true);

    const info = await stat(vaultPath);
    expect(info.mode & 0o777).toBe(0o600);

    const { accounts } = await openVault("hunter2", vaultPath);
    expect(accounts).toEqual([]);
  });

  it("persists and reloads accounts", async () => {
    await initVault("hunter2", vaultPath);
    const opened = await openVault("hunter2", vaultPath);
    await saveAccounts([sampleAccount], opened.key, opened.salt, vaultPath);

    const reopened = await openVault("hunter2", vaultPath);
    expect(reopened.accounts).toEqual([sampleAccount]);
  });

  it("rejects the wrong master password", async () => {
    await initVault("correct-password", vaultPath);
    await expect(openVault("wrong-password", vaultPath)).rejects.toThrow(/incorrect master password/i);
  });

  it("errors when opening a vault that does not exist", async () => {
    await expect(openVault("whatever", vaultPath)).rejects.toThrow(/no vault found/i);
  });

  it("supports changing the master password", async () => {
    await initVault("old-password", vaultPath);
    const opened = await openVault("old-password", vaultPath);
    await saveAccounts([sampleAccount], opened.key, opened.salt, vaultPath);

    await changePassword("old-password", "new-password", vaultPath);

    await expect(openVault("old-password", vaultPath)).rejects.toThrow();
    const { accounts } = await openVault("new-password", vaultPath);
    expect(accounts).toEqual([sampleAccount]);
  });

  it("uses a distinct random IV per save (ciphertext differs across saves)", async () => {
    await initVault("hunter2", vaultPath);
    const opened = await openVault("hunter2", vaultPath);
    await saveAccounts([sampleAccount], opened.key, opened.salt, vaultPath);
    const firstRaw = await import("node:fs/promises").then((fs) => fs.readFile(vaultPath, "utf8"));

    await saveAccounts([sampleAccount], opened.key, opened.salt, vaultPath);
    const secondRaw = await import("node:fs/promises").then((fs) => fs.readFile(vaultPath, "utf8"));

    expect(firstRaw).not.toBe(secondRaw);
  });
});

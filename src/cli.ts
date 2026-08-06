#!/usr/bin/env node
import { Command } from "commander";
import qrcode from "qrcode";
import { totp, secondsRemaining } from "./totp.js";
import { parseOtpauthUri, buildOtpauthUri, type Account } from "./otpauth.js";
import {
  defaultVaultPath,
  vaultExists,
  initVault,
  openVault,
  saveAccounts,
  changePassword,
} from "./vault.js";
import { promptHidden, promptText, closePrompts } from "./prompt.js";

const program = new Command();

program
  .name("hofi")
  .description("HOFI Authenticator - a local TOTP-based two-factor authentication code generator")
  .version("1.0.0");

function formatCode(code: string): string {
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function requirePassword(promptMessage = "Master password: "): Promise<string> {
  const password = await promptHidden(promptMessage);
  if (password.length === 0) {
    fail("Password cannot be empty");
  }
  return password;
}

function findAccount(accounts: Account[], label: string): Account {
  const match = accounts.find(
    (a) => a.label.toLowerCase() === label.toLowerCase() || `${a.issuer ?? ""}:${a.label}`.toLowerCase() === label.toLowerCase(),
  );
  if (!match) {
    fail(`No account found matching "${label}"`);
  }
  return match;
}

program
  .command("init")
  .description("Create a new encrypted vault protected by a master password")
  .action(async () => {
    const path = defaultVaultPath();
    if (await vaultExists(path)) {
      fail(`A vault already exists at ${path}`);
    }
    const password = await requirePassword("Create master password: ");
    const confirm = await requirePassword("Confirm master password: ");
    if (password !== confirm) {
      fail("Passwords do not match");
    }
    await initVault(password, path);
    console.log(`Vault created at ${path}`);
  });

program
  .command("add <label>")
  .description("Add a new 2FA account (from a manual secret or an otpauth:// URI)")
  .option("-s, --secret <secret>", "base32-encoded secret key")
  .option("-u, --uri <uri>", "otpauth:// URI, e.g. copied from an export/QR code")
  .option("-i, --issuer <issuer>", "service/issuer name, e.g. GitHub")
  .option("-a, --algorithm <algorithm>", "SHA1, SHA256 or SHA512", "SHA1")
  .option("-d, --digits <digits>", "number of digits in generated codes", "6")
  .option("-p, --period <period>", "code validity period in seconds", "30")
  .action(async (label: string, opts) => {
    const password = await requirePassword();
    const { accounts, key, salt } = await openVault(password);

    let account: Account;
    if (opts.uri) {
      account = parseOtpauthUri(opts.uri);
      account.label = label || account.label;
    } else {
      const secret = opts.secret ?? (await promptText("Secret (base32): "));
      const digits = Number(opts.digits);
      const period = Number(opts.period);
      const algorithm = String(opts.algorithm).toUpperCase();
      if (!["SHA1", "SHA256", "SHA512"].includes(algorithm)) {
        fail(`Unsupported algorithm: ${algorithm}`);
      }
      account = {
        label,
        secret: secret.replace(/\s+/g, "").toUpperCase(),
        issuer: opts.issuer,
        algorithm: algorithm as Account["algorithm"],
        digits,
        period,
      };
    }

    if (accounts.some((a) => a.label.toLowerCase() === account.label.toLowerCase())) {
      fail(`An account named "${account.label}" already exists`);
    }

    accounts.push(account);
    await saveAccounts(accounts, key, salt);
    console.log(`Added "${account.label}"${account.issuer ? ` (${account.issuer})` : ""}`);
  });

program
  .command("list")
  .alias("ls")
  .description("List all stored accounts")
  .action(async () => {
    const password = await requirePassword();
    const { accounts } = await openVault(password);
    if (accounts.length === 0) {
      console.log("No accounts yet. Add one with: hofi add <label>");
      return;
    }
    for (const account of accounts) {
      const issuer = account.issuer ? `${account.issuer}: ` : "";
      console.log(`${issuer}${account.label}  [${account.algorithm}, ${account.digits} digits, ${account.period}s]`);
    }
  });

function printCode(account: Account) {
  const code = totp({
    secret: account.secret,
    digits: account.digits,
    period: account.period,
    algorithm: account.algorithm,
  });
  const remaining = secondsRemaining(account.period);
  const issuer = account.issuer ? `${account.issuer}: ` : "";
  console.log(`${issuer}${account.label}\t${formatCode(code)}\t(expires in ${remaining}s)`);
}

program
  .command("code [label]")
  .description("Show the current code for one account, or all accounts if omitted")
  .option("-w, --watch", "keep refreshing the code until interrupted (Ctrl+C)")
  .action(async (label: string | undefined, opts) => {
    const password = await requirePassword();
    const { accounts } = await openVault(password);
    if (accounts.length === 0) {
      fail("No accounts stored yet. Add one with: hofi add <label>");
    }

    const targets = label ? [findAccount(accounts, label)] : accounts;

    const render = () => {
      if (opts.watch) {
        console.clear();
      }
      for (const account of targets) {
        printCode(account);
      }
    };

    render();
    if (opts.watch) {
      const interval = setInterval(render, 1000);
      process.on("SIGINT", () => {
        clearInterval(interval);
        process.exit(0);
      });
    }
  });

program
  .command("remove <label>")
  .alias("rm")
  .description("Remove a stored account")
  .action(async (label: string) => {
    const password = await requirePassword();
    const { accounts, key, salt } = await openVault(password);
    const account = findAccount(accounts, label);
    const remaining = accounts.filter((a) => a !== account);
    await saveAccounts(remaining, key, salt);
    console.log(`Removed "${account.label}"`);
  });

program
  .command("export <label>")
  .description("Print the otpauth:// URI and a scannable QR code for an account")
  .action(async (label: string) => {
    const password = await requirePassword();
    const { accounts } = await openVault(password);
    const account = findAccount(accounts, label);
    const uri = buildOtpauthUri(account);
    console.log(uri);
    console.log();
    console.log(await qrcode.toString(uri, { type: "terminal", small: true }));
  });

program
  .command("passwd")
  .description("Change the vault's master password")
  .action(async () => {
    const oldPassword = await requirePassword("Current master password: ");
    const newPassword = await requirePassword("New master password: ");
    const confirm = await requirePassword("Confirm new master password: ");
    if (newPassword !== confirm) {
      fail("Passwords do not match");
    }
    await changePassword(oldPassword, newPassword);
    console.log("Master password updated");
  });

program
  .parseAsync(process.argv)
  .then(() => closePrompts())
  .catch((err: Error) => {
    closePrompts();
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });

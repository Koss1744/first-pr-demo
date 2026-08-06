# HOFI Authenticator

A command-line two-factor authentication (2FA) code generator, like Google
Authenticator, but for your terminal. HOFI Authenticator generates
time-based one-time passwords (TOTP, [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238))
compatible with GitHub, Google, AWS, and any other service that uses
standard TOTP 2FA.

Accounts are stored locally in a vault encrypted with a master password
(AES-256-GCM, key derived with scrypt) — nothing leaves your machine.

## Installation

```bash
npm install
npm run build
npm link   # optional: makes the `hofi` command available globally
```

Or run it directly without linking:

```bash
npm run build
node dist/cli.js <command>
```

## Usage

**Create a vault** (one-time setup, prompts for a master password):

```bash
hofi init
```

**Add an account.** Either paste the `otpauth://` URI a service gives you
when it shows you a 2FA QR code:

```bash
hofi add "alice@example.com" --uri "otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
```

...or enter the secret key manually (the "can't scan the code?" text option
most services offer):

```bash
hofi add "alice@example.com" --secret JBSWY3DPEHPK3PXP --issuer GitHub
```

**Get a code:**

```bash
hofi code                    # show codes for all accounts
hofi code alice@example.com  # show the code for one account
hofi code --watch            # keep refreshing until Ctrl+C
```

**List, remove, export accounts:**

```bash
hofi list
hofi remove alice@example.com
hofi export alice@example.com   # prints the otpauth:// URI and a QR code,
                                 # e.g. to move an account to your phone
```

**Change the master password:**

```bash
hofi passwd
```

Run `hofi --help` or `hofi <command> --help` for the full option list.

## How it works

- Codes are generated with the standard TOTP algorithm (HMAC-SHA1/256/512,
  30-second time steps, 6+ digits) using Node's built-in `crypto` module —
  no code-generation logic depends on third-party packages.
- Accounts are stored at `~/.hofi-authenticator/vault.json`, encrypted with
  AES-256-GCM. The encryption key is derived from your master password via
  scrypt; the password itself is never stored.
- The vault file is created with `0600` permissions (readable only by you).

## Development

```bash
npm run dev -- <command>   # run the CLI from TypeScript source via tsx
npm test                   # run the unit test suite (vitest)
npm run typecheck          # type-check without emitting
```

The test suite verifies the TOTP implementation against the official
[RFC 6238 Appendix B test vectors](https://datatracker.ietf.org/doc/html/rfc6238#appendix-B)
for SHA1, SHA256, and SHA512.

## Disclaimer

This is a personal/educational 2FA tool. Review the code before relying on
it to protect accounts you can't afford to lose access to, and keep a
backup of your secrets (e.g. via `hofi export`) in case you lose the vault.

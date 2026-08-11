# HOFI Authenticator

Time-based one-time password (TOTP, [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238))
two-factor authentication, in two forms:

- **[`packages/cli`](packages/cli)** - a personal command-line authenticator
  app, like Google Authenticator for your terminal. Single user, secrets
  encrypted locally with a master password.
- **[`packages/server`](packages/server)** - `@hofi/server`, an internal
  multi-user MFA verification service for gating company logins (AD-backed),
  plus an optional OIDC identity provider for web SSO. Phase 1 (verification
  API) and Phase 2 (web SSO) are both implemented; Windows workstation logon
  is still ahead. See its README for setup, API reference, and the roadmap.

Both share **[`packages/core`](packages/core)**, `@hofi/core`: the actual
TOTP/HOTP algorithm (HMAC-SHA1/256/512 per RFC 4226/6238) and `otpauth://`
URI parsing, built on nothing but Node's `crypto` module and verified against
the official RFC 6238 test vectors.

This is an npm workspaces monorepo - install and build once at the root.

## Quick start

```bash
npm install
npm run build       # builds core, then cli and server
npm test             # unit tests across all packages
npm run test:integration  # server integration tests, needs a local Postgres
```

## CLI usage

```bash
node packages/cli/dist/cli.js init                                   # create a vault
node packages/cli/dist/cli.js add "alice@example.com" --secret ABC... --issuer GitHub
node packages/cli/dist/cli.js code                                    # show current codes
```

Or `npm link` inside `packages/cli` to get a global `hofi` command. Full
command reference in [`packages/cli/README`](packages/cli) (inline `--help`).

## Server usage

See [`packages/server/README.md`](packages/server/README.md) for setup
(Postgres, root encryption key, AD/LDAP config), the API reference, and the
Phase 1 known-risks/roadmap notes.

## Development

```bash
npm run dev:cli -- <command>   # run the CLI from TypeScript source via tsx
npm run dev:server              # run the server from TypeScript source via tsx
npm run typecheck                # type-check the whole workspace (tsc -b)
```

## Disclaimer

The CLI is a personal/educational tool - review the code before relying on
it for accounts you can't afford to lose access to. The server targets real
internal infrastructure and is still a staged rollout (Phase 3, Windows
workstation logon, isn't built yet); read its README's "Known risks"
sections before deploying it against production AD.

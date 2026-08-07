export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
}

/** Minimal shape we require of statically-configured OIDC RPs; passed through as-is to oidc-provider otherwise. */
export interface OidcClientConfig {
  client_id: string;
  redirect_uris: string[];
  [key: string]: unknown;
}

export interface OidcConfig {
  /** Full external base URL this server is reachable at, e.g. https://sso.example.internal - used as the OIDC issuer. */
  issuer: string;
  /** Signing keys for oidc-provider's own cookies, newest first. Rotate by prepending a new one. */
  cookieKeys: string[];
  /** Private JWKS used to sign ID tokens, generated with `npm run create-oidc-jwks -w @hofi/server`. */
  jwks: { keys: Record<string, unknown>[] };
  clients: OidcClientConfig[];
}

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  /** KEK version -> 32-byte root key, parsed from HOFI_ROOT_KEY_V<n> env vars. */
  rootKeys: Map<number, Buffer>;
  activeKekVersion: number;
  directoryImpl: "ldap" | "memory";
  ldap?: LdapConfig;
  maxFailedAttempts: number;
  lockoutDurationMs: number;
  totpDriftSteps: number;
  /** Phase 2 web SSO. Unset means the OIDC provider is not mounted at all. */
  oidc?: OidcConfig;
}

const ROOT_KEY_PATTERN = /^HOFI_ROOT_KEY_V(\d+)$/;

function parseRootKeys(env: NodeJS.ProcessEnv): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    const match = ROOT_KEY_PATTERN.exec(name);
    if (!match || !value) {
      continue;
    }
    const version = Number(match[1]);
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) {
      throw new Error(`${name} must decode to exactly 32 bytes (got ${key.length})`);
    }
    keys.set(version, key);
  }
  return keys;
}

function parseOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | undefined {
  const { HOFI_OIDC_ISSUER, HOFI_OIDC_COOKIE_KEYS, HOFI_OIDC_JWKS, HOFI_OIDC_CLIENTS } = env;
  if (!HOFI_OIDC_ISSUER && !HOFI_OIDC_COOKIE_KEYS && !HOFI_OIDC_JWKS && !HOFI_OIDC_CLIENTS) {
    return undefined;
  }
  if (!HOFI_OIDC_ISSUER || !HOFI_OIDC_COOKIE_KEYS || !HOFI_OIDC_JWKS || !HOFI_OIDC_CLIENTS) {
    throw new Error(
      "HOFI_OIDC_ISSUER, HOFI_OIDC_COOKIE_KEYS, HOFI_OIDC_JWKS and HOFI_OIDC_CLIENTS are all required to enable web SSO (Phase 2) - unset all of them to leave it disabled",
    );
  }

  const cookieKeys = HOFI_OIDC_COOKIE_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  if (cookieKeys.some((k) => k.length < 32)) {
    throw new Error("Each key in HOFI_OIDC_COOKIE_KEYS must be at least 32 characters");
  }

  let jwks: OidcConfig["jwks"];
  try {
    jwks = JSON.parse(HOFI_OIDC_JWKS);
  } catch (err) {
    throw new Error(`HOFI_OIDC_JWKS is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error('HOFI_OIDC_JWKS must be a JSON object like {"keys":[...]} with at least one private JWK');
  }

  let clients: OidcConfig["clients"];
  try {
    clients = JSON.parse(HOFI_OIDC_CLIENTS);
  } catch (err) {
    throw new Error(`HOFI_OIDC_CLIENTS is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error("HOFI_OIDC_CLIENTS must be a non-empty JSON array of OIDC client metadata objects");
  }
  for (const client of clients) {
    if (!client.client_id || !Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
      throw new Error("Every entry in HOFI_OIDC_CLIENTS needs a client_id and a non-empty redirect_uris array");
    }
  }

  return { issuer: HOFI_OIDC_ISSUER, cookieKeys, jwks, clients };
}

/** Loads and validates server configuration from environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rootKeys = parseRootKeys(env);
  if (rootKeys.size === 0) {
    throw new Error("No HOFI_ROOT_KEY_V<n> configured. Generate one with: openssl rand -base64 32");
  }

  const activeKekVersion = Number(env.HOFI_ROOT_KEY_ACTIVE_VERSION ?? Math.max(...rootKeys.keys()));
  if (!rootKeys.has(activeKekVersion)) {
    throw new Error(
      `HOFI_ROOT_KEY_ACTIVE_VERSION=${activeKekVersion} has no matching HOFI_ROOT_KEY_V${activeKekVersion}`,
    );
  }

  const databaseUrl = env.HOFI_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("HOFI_DATABASE_URL is required");
  }

  const directoryImpl = env.HOFI_DIRECTORY_IMPL ?? "ldap";
  if (directoryImpl !== "ldap" && directoryImpl !== "memory") {
    throw new Error(`HOFI_DIRECTORY_IMPL must be "ldap" or "memory", got "${directoryImpl}"`);
  }

  let ldap: LdapConfig | undefined;
  if (directoryImpl === "ldap") {
    const { HOFI_LDAP_URL, HOFI_LDAP_BIND_DN, HOFI_LDAP_BIND_PASSWORD, HOFI_LDAP_BASE_DN } = env;
    if (!HOFI_LDAP_URL || !HOFI_LDAP_BIND_DN || !HOFI_LDAP_BIND_PASSWORD || !HOFI_LDAP_BASE_DN) {
      throw new Error(
        "HOFI_LDAP_URL, HOFI_LDAP_BIND_DN, HOFI_LDAP_BIND_PASSWORD and HOFI_LDAP_BASE_DN are all required when HOFI_DIRECTORY_IMPL=ldap",
      );
    }
    ldap = {
      url: HOFI_LDAP_URL,
      bindDn: HOFI_LDAP_BIND_DN,
      bindPassword: HOFI_LDAP_BIND_PASSWORD,
      baseDn: HOFI_LDAP_BASE_DN,
      userFilter: env.HOFI_LDAP_USER_FILTER ?? "(&(objectClass=user)(sAMAccountName={username}))",
    };
  }

  return {
    port: Number(env.HOFI_SERVER_PORT ?? 3000),
    databaseUrl,
    rootKeys,
    activeKekVersion,
    directoryImpl,
    ldap,
    maxFailedAttempts: Number(env.HOFI_MAX_FAILED_ATTEMPTS ?? 5),
    lockoutDurationMs: Number(env.HOFI_LOCKOUT_DURATION_MS ?? 15 * 60 * 1000),
    totpDriftSteps: Number(env.HOFI_TOTP_DRIFT_STEPS ?? 1),
    oidc: parseOidcConfig(env),
  };
}

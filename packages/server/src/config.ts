export interface LdapConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
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
  };
}

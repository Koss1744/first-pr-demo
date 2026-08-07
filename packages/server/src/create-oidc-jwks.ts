import { generateKeyPairSync, randomUUID } from "node:crypto";

/**
 * Prints a fresh single-key JWKS (private RSA key, RS256) to stdout for HOFI_OIDC_JWKS. Run once
 * per deployment and store the output in a secrets manager, the same way as HOFI_ROOT_KEY_V1 -
 * this key signs every ID token the OIDC provider issues.
 */
function main(): void {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = randomUUID();
  jwk.alg = "RS256";
  jwk.use = "sig";
  console.log(JSON.stringify({ keys: [jwk] }));
}

main();

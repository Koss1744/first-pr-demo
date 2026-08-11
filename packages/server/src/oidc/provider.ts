import Provider, { type ClientMetadata, type Configuration, type JWKS } from "oidc-provider";
import type { ServerConfig } from "../config.js";
import type { Database } from "../db.js";
import type { Directory } from "../directory/types.js";
import { createOidcAdapter } from "./adapter.js";

/**
 * Builds the oidc-provider instance wrapping this server's MFA verification: password checked via
 * Directory.verifyCredentials, TOTP via the same verifyUser() the Windows Credential Provider will
 * use in Phase 3. See src/routes/oidc-interactions.ts for the actual login/MFA screens.
 */
export function createOidcProvider(db: Database, config: ServerConfig, directory: Directory): Provider {
  const oidc = config.oidc;
  if (!oidc) {
    throw new Error("createOidcProvider() called without HOFI_OIDC_* configured");
  }

  const configuration: Configuration = {
    adapter: createOidcAdapter(db),
    clients: oidc.clients as ClientMetadata[],
    jwks: oidc.jwks as JWKS,
    cookies: {
      keys: oidc.cookieKeys,
    },
    claims: {
      openid: ["sub"],
      profile: ["name", "preferred_username"],
    },
    scopes: ["openid", "profile"],
    features: {
      devInteractions: { enabled: false },
    },
    interactions: {
      url(_ctx, interaction) {
        return `/interaction/${interaction.uid}`;
      },
    },
    ttl: {
      Interaction: 10 * 60,
      Session: 12 * 60 * 60,
      Grant: 30 * 24 * 60 * 60,
      AccessToken: 60 * 60,
      IdToken: 60 * 60,
    },
    async findAccount(_ctx, sub) {
      const user = await directory.lookupUser(sub);
      if (!user || !user.active) {
        return undefined;
      }
      return {
        accountId: sub,
        async claims() {
          return { sub, name: user.displayName, preferred_username: user.username };
        },
      };
    },
  };

  const provider = new Provider(oidc.issuer, configuration);
  provider.proxy = true;
  return provider;
}

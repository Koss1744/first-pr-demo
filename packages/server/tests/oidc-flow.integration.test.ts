import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { totp } from "@hofi/core";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { OidcConfig, ServerConfig } from "../src/config.js";
import type { Database } from "../src/db.js";
import { InMemoryDirectory } from "../src/directory/memory-directory.js";
import { enrollConfirm, enrollStart } from "../src/verify/verify-logic.js";
import { createTestDatabase } from "./support/test-db.js";

const USERNAME = "jdoe";
const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "intranet";
const CLIENT_SECRET = "intranet-secret";
const REDIRECT_URI = "https://rp.example.test/callback";

let db: Database;
let dropDb: () => Promise<void>;
let oidc: OidcConfig;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  oidc = {
    issuer: "http://127.0.0.1",
    cookieKeys: ["test-cookie-signing-key-at-least-32-characters-long"],
    jwks: { keys: [jwk] },
    clients: [
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
    ],
  };
});

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.pool;
  dropDb = created.drop;
});

afterEach(async () => {
  await dropDb();
});

function testConfig(): ServerConfig {
  return {
    port: 0,
    databaseUrl: "unused-in-tests",
    rootKeys: new Map([[1, randomBytes(32)]]),
    activeKekVersion: 1,
    directoryImpl: "memory",
    maxFailedAttempts: 5,
    lockoutDurationMs: 900_000,
    totpDriftSteps: 1,
    oidc,
  };
}

const CTX = { clientId: "test-setup", ip: "127.0.0.1" };

/** Enrolls jdoe's TOTP secret and returns a function producing a fresh, unconsumed code. */
async function enrollTotp(db: Database, config: ServerConfig, directory: InMemoryDirectory): Promise<(offsetSeconds: number) => string> {
  const started = await enrollStart(db, directory, config, { username: USERNAME, ...CTX });
  if (started.outcome !== "started") {
    throw new Error(`enrollStart did not start: ${started.outcome}`);
  }
  const anchorMs = Date.now();
  const codeAt = (offsetSeconds: number) =>
    totp({
      secret: started.secret,
      algorithm: started.algorithm,
      digits: started.digits,
      period: started.period,
      timestamp: anchorMs + offsetSeconds * 1000,
    });
  const confirmed = await enrollConfirm(db, config, { username: USERNAME, code: codeAt(-30), ...CTX });
  if (confirmed.outcome !== "confirmed") {
    throw new Error(`enrollConfirm did not confirm: ${confirmed.outcome}`);
  }
  return codeAt;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Follows our own /auth resume and /interaction hops (oidc-provider issues these as absolute URLs on the request's own origin) until landing on the RP's redirect_uri. */
async function followToCallback(agent: ReturnType<typeof request.agent>, res: request.Response): Promise<URL> {
  let current = res;
  for (let hop = 0; hop < 10; hop++) {
    expect(current.status).toBeGreaterThanOrEqual(300);
    expect(current.status).toBeLessThan(400);
    const location = new URL(current.headers.location as string, REDIRECT_URI);
    if (location.pathname !== "/auth" && !location.pathname.startsWith("/auth/") && !location.pathname.startsWith("/interaction/")) {
      return location;
    }
    current = await agent.get(location.pathname + location.search);
  }
  throw new Error("redirect chain did not reach the RP redirect_uri within 10 hops");
}

describe("OIDC web SSO: password + TOTP through to a token response", () => {
  it("completes an authorization_code + PKCE flow end to end", async () => {
    const directory = new InMemoryDirectory([{ username: USERNAME, displayName: "Jane Doe", active: true, password: PASSWORD }]);
    const config = testConfig();
    const codeAt = await enrollTotp(db, config, directory);

    const app = createApp(db, config, directory);
    const agent = request.agent(app);
    const { verifier, challenge } = pkcePair();

    const authorizeRes = await agent.get("/auth").query({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "openid profile",
      state: "xyz-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(authorizeRes.status).toBeGreaterThanOrEqual(300);
    expect(authorizeRes.status).toBeLessThan(400);
    const interactionPath = authorizeRes.headers.location as string;
    expect(interactionPath).toMatch(/^\/interaction\//);

    const loginPageRes = await agent.get(interactionPath);
    expect(loginPageRes.status).toBe(200);
    expect(loginPageRes.text).toContain(`action="${interactionPath}/login"`);

    const mfaPageRes = await agent
      .post(`${interactionPath}/login`)
      .type("form")
      .send({ username: USERNAME, password: PASSWORD });
    expect(mfaPageRes.status).toBe(200);
    expect(mfaPageRes.text).toContain("6-digit code");

    const mfaSubmitRes = await agent.post(`${interactionPath}/mfa`).type("form").send({ code: codeAt(0) });
    const callbackUrl = await followToCallback(agent, mfaSubmitRes);

    expect(callbackUrl.origin + callbackUrl.pathname).toBe(REDIRECT_URI);
    expect(callbackUrl.searchParams.get("state")).toBe("xyz-state");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await agent
      .post("/token")
      .type("form")
      .auth(CLIENT_ID, CLIENT_SECRET)
      .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.access_token).toBeTruthy();
    expect(tokenRes.body.id_token).toBeTruthy();

    const userinfoRes = await agent.get("/me").set("Authorization", `Bearer ${tokenRes.body.access_token}`);
    expect(userinfoRes.status).toBe(200);
    expect(userinfoRes.body.preferred_username).toBe(USERNAME);
    expect(userinfoRes.body.name).toBe("Jane Doe");
  });

  it("rejects a wrong AD password without ever reaching the MFA step", async () => {
    const directory = new InMemoryDirectory([{ username: USERNAME, displayName: "Jane Doe", active: true, password: PASSWORD }]);
    const config = testConfig();
    const app = createApp(db, config, directory);
    const agent = request.agent(app);

    const authorizeRes = await agent.get("/auth").query({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "openid",
      state: "s",
    });
    const interactionPath = authorizeRes.headers.location as string;

    const res = await agent.post(`${interactionPath}/login`).type("form").send({ username: USERNAME, password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.text).toContain("Invalid username or password");
  });

  it("rejects a wrong TOTP code and lets the user retry", async () => {
    const directory = new InMemoryDirectory([{ username: USERNAME, displayName: "Jane Doe", active: true, password: PASSWORD }]);
    const config = testConfig();
    await enrollTotp(db, config, directory);
    const app = createApp(db, config, directory);
    const agent = request.agent(app);

    const authorizeRes = await agent.get("/auth").query({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "openid",
      state: "s",
    });
    const interactionPath = authorizeRes.headers.location as string;
    await agent.post(`${interactionPath}/login`).type("form").send({ username: USERNAME, password: PASSWORD });

    const res = await agent.post(`${interactionPath}/mfa`).type("form").send({ code: "000000" });
    expect(res.status).toBe(401);
    expect(res.text).toContain("Incorrect code");
  });
});

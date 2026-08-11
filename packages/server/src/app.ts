import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ipRateLimit } from "./auth/rate-limit.js";
import type { ServerConfig } from "./config.js";
import type { Database } from "./db.js";
import type { Directory } from "./directory/types.js";
import { createOidcProvider } from "./oidc/provider.js";
import { adminRouter } from "./routes/admin.js";
import { enrollRouter } from "./routes/enroll.js";
import { healthRouter } from "./routes/health.js";
import { oidcInteractionRouter } from "./routes/oidc-interactions.js";
import { verifyRouter } from "./routes/verify.js";

/** Builds the Express app without starting a listener - used by server.ts and by tests via supertest. */
export function createApp(db: Database, config: ServerConfig, directory: Directory): Express {
  const app = express();
  app.use(express.json());
  // Scoped to /api/v1: those callers are a small known set of internal service IPs (see
  // ipRateLimit's own docs). The OIDC surface below is hit directly by end-user browsers,
  // often many of them sharing one corporate NAT egress IP, where the same per-IP ceiling
  // would produce false 429s for unrelated users - real MFA brute-force defense for it is
  // the per-user TOTP lockout in verify-logic.ts, not an IP-based limiter.
  app.use("/api/v1", ipRateLimit());

  app.use("/api/v1", healthRouter(db));
  app.use("/api/v1", enrollRouter(db, config, directory));
  app.use("/api/v1", verifyRouter(db, config));
  app.use("/api/v1", adminRouter(db));

  // Phase 2 (web SSO) - only mounted when HOFI_OIDC_* is configured, so a Phase-1-only
  // deployment (no OIDC clients yet) is completely unaffected.
  if (config.oidc) {
    // Matches provider.proxy = true below: this deployment is documented to run behind a
    // TLS-offloading reverse proxy, so req.secure needs to trust X-Forwarded-Proto too -
    // otherwise the pending-login cookie's Secure flag would always be false.
    app.set("trust proxy", true);
    const provider = createOidcProvider(db, config, directory);
    app.use(oidcInteractionRouter(provider, db, config, directory));
    app.use(provider.callback());
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

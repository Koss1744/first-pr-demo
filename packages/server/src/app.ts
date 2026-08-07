import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ipRateLimit } from "./auth/rate-limit.js";
import type { ServerConfig } from "./config.js";
import type { Database } from "./db.js";
import type { Directory } from "./directory/types.js";
import { adminRouter } from "./routes/admin.js";
import { enrollRouter } from "./routes/enroll.js";
import { healthRouter } from "./routes/health.js";
import { verifyRouter } from "./routes/verify.js";

/** Builds the Express app without starting a listener - used by server.ts and by tests via supertest. */
export function createApp(db: Database, config: ServerConfig, directory: Directory): Express {
  const app = express();
  app.use(express.json());
  app.use(ipRateLimit());

  app.use("/api/v1", healthRouter(db));
  app.use("/api/v1", enrollRouter(db, config, directory));
  app.use("/api/v1", verifyRouter(db, config));
  app.use("/api/v1", adminRouter(db));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

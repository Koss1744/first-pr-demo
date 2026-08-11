import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Coarse per-IP request-rate ceiling, purely as defense-in-depth against a
 * misbehaving client (all legitimate callers are a small, known set of
 * internal service IPs). Not a substitute for the per-user lockout in
 * verify-logic.ts, which is the real security control.
 */
export function ipRateLimit({ maxRequests = 60, windowMs = 60_000 } = {}) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(ip);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      // Opportunistic sweep so `buckets` doesn't grow forever - bounded by however many
      // distinct IPs were active in roughly the last window, not the process lifetime.
      for (const [staleIp, staleBucket] of buckets) {
        if (now - staleBucket.windowStart >= windowMs) {
          buckets.delete(staleIp);
        }
      }
      buckets.set(ip, { count: 1, windowStart: now });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    bucket.count += 1;
    next();
  };
}

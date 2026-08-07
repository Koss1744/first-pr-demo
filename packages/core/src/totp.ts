import { createHmac, timingSafeEqual } from "node:crypto";
import { base32Decode } from "./base32.js";

export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpOptions {
  /** Base32-encoded shared secret. */
  secret: string;
  /** Number of digits in the generated code. Default 6. */
  digits?: number;
  /** Time step in seconds. Default 30. */
  period?: number;
  /** HMAC algorithm. Default SHA1 (used by virtually all real-world issuers). */
  algorithm?: OtpAlgorithm;
  /** Unix time in milliseconds to generate the code for. Default: now. */
  timestamp?: number;
}

const ALGORITHM_MAP: Record<OtpAlgorithm, string> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
};

/**
 * HOTP per RFC 4226: HMAC-based one-time password from a secret and counter.
 */
export function hotp(
  secretBuffer: Buffer,
  counter: number | bigint,
  { digits = 6, algorithm = "SHA1" }: { digits?: number; algorithm?: OtpAlgorithm } = {},
): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac(ALGORITHM_MAP[algorithm], secretBuffer).update(counterBuffer).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = (binCode % 10 ** digits).toString().padStart(digits, "0");
  return code;
}

/**
 * TOTP per RFC 6238: HOTP evaluated at the time-step counter derived from
 * the current (or given) unix timestamp.
 */
export function totp(options: TotpOptions): string {
  const { secret, digits = 6, period = 30, algorithm = "SHA1", timestamp = Date.now() } = options;
  const counter = Math.floor(Math.floor(timestamp / 1000) / period);
  return hotp(base32Decode(secret), counter, { digits, algorithm });
}

/** Seconds remaining until the current time-step (and thus the code) rolls over. */
export function secondsRemaining(period = 30, timestamp = Date.now()): number {
  const secondsIntoStep = Math.floor(timestamp / 1000) % period;
  return period - secondsIntoStep;
}

export interface MatchTotpWindowOptions {
  digits?: number;
  period?: number;
  algorithm?: OtpAlgorithm;
  /** Unix time in milliseconds to match against. Default: now. */
  timestamp?: number;
  /** How many time-steps before/after the current one to also accept, to absorb clock drift. Default 1. */
  driftSteps?: number;
}

/**
 * Checks a submitted code against a window of time-steps around now (to
 * absorb clock drift between server and authenticator app), using a
 * constant-time comparison per candidate to avoid a timing side channel.
 * Returns the matched absolute time-step counter, or null if no step in
 * the window matches - callers use the returned step as a replay watermark
 * (only accept a step strictly greater than the last one seen for a user).
 */
export function matchTotpWindow(
  secretBuffer: Buffer,
  code: string,
  { digits = 6, period = 30, algorithm = "SHA1", timestamp = Date.now(), driftSteps = 1 }: MatchTotpWindowOptions = {},
): number | null {
  const currentStep = Math.floor(Math.floor(timestamp / 1000) / period);
  const codeBuffer = Buffer.from(code, "utf8");

  for (let delta = -driftSteps; delta <= driftSteps; delta++) {
    const step = currentStep + delta;
    if (step < 0) {
      continue;
    }
    const candidateBuffer = Buffer.from(hotp(secretBuffer, step, { digits, algorithm }), "utf8");
    if (candidateBuffer.length === codeBuffer.length && timingSafeEqual(candidateBuffer, codeBuffer)) {
      return step;
    }
  }
  return null;
}

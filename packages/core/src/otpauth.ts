import type { OtpAlgorithm } from "./totp.js";

export interface Account {
  /** Display label, e.g. "alice@example.com". */
  label: string;
  /** Base32-encoded shared secret. */
  secret: string;
  /** Service/provider name, e.g. "GitHub". */
  issuer?: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
}

const DEFAULTS = {
  algorithm: "SHA1" as OtpAlgorithm,
  digits: 6,
  period: 30,
};

/**
 * Parses an `otpauth://totp/...` URI (the format encoded in the QR codes
 * shown by GitHub, Google, AWS, etc. when enabling 2FA) into an Account.
 */
export function parseOtpauthUri(uri: string): Account {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Invalid otpauth URI");
  }

  if (parsed.protocol !== "otpauth:") {
    throw new Error("URI must use the otpauth:// scheme");
  }
  if (parsed.host !== "totp") {
    throw new Error(`Unsupported OTP type: ${parsed.host}. Only 'totp' is supported.`);
  }

  const rawLabel = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const [labelIssuerPart, labelAccountPart] = rawLabel.includes(":")
    ? [rawLabel.slice(0, rawLabel.indexOf(":")), rawLabel.slice(rawLabel.indexOf(":") + 1)]
    : [undefined, rawLabel];

  const params = parsed.searchParams;
  const secret = params.get("secret");
  if (!secret) {
    throw new Error("otpauth URI is missing the 'secret' parameter");
  }

  const issuer = params.get("issuer") ?? labelIssuerPart ?? undefined;
  const algorithmParam = (params.get("algorithm") ?? DEFAULTS.algorithm).toUpperCase();
  if (!["SHA1", "SHA256", "SHA512"].includes(algorithmParam)) {
    throw new Error(`Unsupported algorithm: ${algorithmParam}`);
  }

  const digits = Number(params.get("digits") ?? DEFAULTS.digits);
  const period = Number(params.get("period") ?? DEFAULTS.period);

  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new Error("digits must be an integer between 6 and 10");
  }
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error("period must be a positive integer");
  }

  return {
    label: labelAccountPart.trim(),
    secret: secret.replace(/\s+/g, "").toUpperCase(),
    issuer,
    algorithm: algorithmParam as OtpAlgorithm,
    digits,
    period,
  };
}

/** Builds an `otpauth://totp/...` URI from an Account, for export/QR display. */
export function buildOtpauthUri(account: Account): string {
  const label = account.issuer ? `${account.issuer}:${account.label}` : account.label;
  const params = new URLSearchParams({
    secret: account.secret,
    algorithm: account.algorithm,
    digits: String(account.digits),
    period: String(account.period),
  });
  if (account.issuer) {
    params.set("issuer", account.issuer);
  }
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

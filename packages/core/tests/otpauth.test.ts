import { describe, expect, it } from "vitest";
import { buildOtpauthUri, parseOtpauthUri } from "../src/otpauth.js";

describe("parseOtpauthUri", () => {
  it("parses a standard GitHub-style URI with issuer:label", () => {
    const account = parseOtpauthUri(
      "otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30",
    );
    expect(account).toEqual({
      label: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "GitHub",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
  });

  it("applies RFC 6238 defaults when algorithm/digits/period are omitted", () => {
    const account = parseOtpauthUri("otpauth://totp/example.com?secret=JBSWY3DPEHPK3PXP");
    expect(account.algorithm).toBe("SHA1");
    expect(account.digits).toBe(6);
    expect(account.period).toBe(30);
  });

  it("derives issuer from the label when the issuer param is absent", () => {
    const account = parseOtpauthUri("otpauth://totp/Acme:bob?secret=JBSWY3DPEHPK3PXP");
    expect(account.issuer).toBe("Acme");
    expect(account.label).toBe("bob");
  });

  it("rejects non-otpauth schemes", () => {
    expect(() => parseOtpauthUri("https://example.com")).toThrow();
  });

  it("rejects hotp (only totp is supported)", () => {
    expect(() => parseOtpauthUri("otpauth://hotp/bob?secret=JBSWY3DPEHPK3PXP")).toThrow();
  });

  it("rejects a missing secret", () => {
    expect(() => parseOtpauthUri("otpauth://totp/bob")).toThrow();
  });

  it("rejects an unsupported algorithm", () => {
    expect(() => parseOtpauthUri("otpauth://totp/bob?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toThrow();
  });
});

describe("buildOtpauthUri", () => {
  it("round-trips through parseOtpauthUri", () => {
    const original = {
      label: "alice@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "GitHub",
      algorithm: "SHA1" as const,
      digits: 6,
      period: 30,
    };
    const uri = buildOtpauthUri(original);
    expect(parseOtpauthUri(uri)).toEqual(original);
  });

  it("omits issuer from the query string when not set", () => {
    const uri = buildOtpauthUri({
      label: "bob",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    expect(uri).not.toContain("issuer=");
  });
});

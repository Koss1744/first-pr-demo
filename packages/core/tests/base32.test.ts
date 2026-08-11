import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "../src/base32.js";

// RFC 4648 section 10 test vectors (padding stripped, since we encode unpadded).
const VECTORS: Array<[string, string]> = [
  ["", ""],
  ["f", "MY"],
  ["fo", "MZXQ"],
  ["foo", "MZXW6"],
  ["foob", "MZXW6YQ"],
  ["fooba", "MZXW6YTB"],
  ["foobar", "MZXW6YTBOI"],
];

describe("base32Encode", () => {
  for (const [input, expected] of VECTORS) {
    it(`encodes "${input}"`, () => {
      expect(base32Encode(Buffer.from(input, "ascii"))).toBe(expected);
    });
  }
});

describe("base32Decode", () => {
  for (const [expected, input] of VECTORS) {
    if (input === "") continue;
    it(`decodes "${input}"`, () => {
      expect(base32Decode(input).toString("ascii")).toBe(expected);
    });
  }

  it("is case-insensitive and ignores padding/whitespace", () => {
    expect(base32Decode("mzxw6ytb").toString("ascii")).toBe("fooba");
    expect(base32Decode("MZXW6YTB====").toString("ascii")).toBe("fooba");
    expect(base32Decode(" MZXW 6YTB \n").toString("ascii")).toBe("fooba");
  });

  it("throws on invalid characters", () => {
    expect(() => base32Decode("!!!")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => base32Decode("")).toThrow();
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254, 128, 42, 17]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
});

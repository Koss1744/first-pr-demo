import { describe, expect, it } from "vitest";
import {
  isValidBankAccount,
  isValidBic,
  isValidEmail,
  isValidInn,
  isValidKpp,
  isValidOgrn,
  isValidPhone,
  normalizeCode,
  normalizeText,
} from "../src/counterparties/requisites.js";
import { validateCounterparty } from "../src/counterparties/validate.js";

// Publicly published requisites of real organizations, used as the external
// check that the checksum implementations match the official algorithms rather
// than merely agreeing with themselves.
const SBER = { inn: "7707083893", kpp: "773601001", ogrn: "1027700132195", bic: "044525225", corr: "30101810400000000225" };

describe("isValidInn", () => {
  it("accepts real 10-digit organization ИНН", () => {
    expect(isValidInn(SBER.inn)).toBe(true);
    expect(isValidInn("7736207543")).toBe(true);
  });

  it("accepts 12-digit ИНН of individuals", () => {
    expect(isValidInn("500100732259")).toBe(true);
    expect(isValidInn("771234567859")).toBe(true);
  });

  it("rejects a single altered check digit", () => {
    expect(isValidInn("7707083894")).toBe(false);
    expect(isValidInn("500100732258")).toBe(false);
  });

  it("rejects anything that is not exactly 10 or 12 digits", () => {
    expect(isValidInn("770708389")).toBe(false);
    expect(isValidInn("77070838931")).toBe(false);
    expect(isValidInn("77070838-3")).toBe(false);
    expect(isValidInn("")).toBe(false);
  });
});

describe("isValidOgrn", () => {
  it("accepts a real 13-digit ОГРН and a 15-digit ОГРНИП", () => {
    expect(isValidOgrn(SBER.ogrn)).toBe(true);
    expect(isValidOgrn("304774600000000")).toBe(true);
  });

  it("rejects a wrong check digit and wrong lengths", () => {
    expect(isValidOgrn("1027700132196")).toBe(false);
    expect(isValidOgrn("10277001321")).toBe(false);
    expect(isValidOgrn("30477460000000")).toBe(false);
  });
});

describe("isValidKpp", () => {
  it("accepts 9 characters with an optional letter pair in the middle", () => {
    expect(isValidKpp(SBER.kpp)).toBe(true);
    expect(isValidKpp("7736AB001")).toBe(true);
  });

  it("rejects wrong length, lowercase letters and letters outside positions 5-6", () => {
    expect(isValidKpp("77360100")).toBe(false);
    expect(isValidKpp("7736ab001")).toBe(false);
    expect(isValidKpp("AB3601001")).toBe(false);
  });
});

describe("isValidBic / isValidBankAccount", () => {
  it("accepts a real БИК and its correspondent account", () => {
    expect(isValidBic(SBER.bic)).toBe(true);
    expect(isValidBankAccount(SBER.corr, SBER.bic)).toBe(true);
  });

  it("accepts a settlement account whose key digit matches the БИК", () => {
    expect(isValidBankAccount("40702810200000000001", SBER.bic)).toBe(true);
  });

  it("rejects an account whose key digit does not match", () => {
    expect(isValidBankAccount("40702810300000000001", SBER.bic)).toBe(false);
    expect(isValidBankAccount("30101810400000000226", SBER.bic)).toBe(false);
  });

  it("rejects a correct account checked against a different bank", () => {
    // Same digits, another bank: the key is computed over БИК digits, so this
    // is exactly the "pasted the account under the wrong bank" mistake.
    expect(isValidBankAccount("40702810200000000001", "044525226")).toBe(false);
  });

  it("rejects malformed БИК", () => {
    expect(isValidBic("14525225")).toBe(false);
    expect(isValidBic("144525225")).toBe(false);
  });
});

describe("isValidEmail / isValidPhone", () => {
  it("accepts ordinary contact details", () => {
    expect(isValidEmail("buh@example.ru")).toBe(true);
    expect(isValidPhone("+7 (495) 500-55-50")).toBe(true);
    expect(isValidPhone("84955005550")).toBe(true);
  });

  it("rejects malformed ones", () => {
    expect(isValidEmail("buh@example")).toBe(false);
    expect(isValidEmail("buh example.ru")).toBe(false);
    expect(isValidPhone("1234")).toBe(false);
    expect(isValidPhone("+7 (495) ООО-55-50")).toBe(false);
  });
});

describe("normalizeText / normalizeCode", () => {
  it("collapses whitespace and turns blanks into undefined", () => {
    expect(normalizeText("  ООО   Ромашка \n")).toBe("ООО Ромашка");
    expect(normalizeText("   ")).toBeUndefined();
    expect(normalizeText(42)).toBeUndefined();
  });

  it("strips the separators people paste inside requisite numbers", () => {
    expect(normalizeCode(" 7707-083 893 ")).toBe("7707083893");
    expect(normalizeCode("7736ab001")).toBe("7736AB001");
  });
});

describe("validateCounterparty - kind rules", () => {
  const legalEntity = {
    kind: "legal_entity",
    name: "ПАО Сбербанк",
    inn: SBER.inn,
    kpp: SBER.kpp,
    ogrn: SBER.ogrn,
  };

  it("accepts a complete legal entity and normalizes its fields", () => {
    const result = validateCounterparty({ ...legalEntity, name: "  ПАО   Сбербанк ", email: "BUH@Example.RU" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("ПАО Сбербанк");
    expect(result.value.email).toBe("buh@example.ru");
    expect(result.value.countryCode).toBe("RU");
  });

  it("requires ИНН, КПП and ОГРН from a legal entity", () => {
    const result = validateCounterparty({ kind: "legal_entity", name: "ООО Ромашка" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { field: "inn", code: "required" },
        { field: "kpp", code: "required" },
        { field: "ogrn", code: "required" },
      ]),
    );
  });

  it("rejects a 12-digit ИНН on a legal entity", () => {
    const result = validateCounterparty({ ...legalEntity, inn: "500100732259" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "inn", code: "wrong_length_for_kind" });
  });

  it("rejects a КПП on a sole proprietor - they are never issued one", () => {
    const result = validateCounterparty({
      kind: "sole_proprietor",
      name: "ИП Иванов И.И.",
      inn: "771234567859",
      ogrn: "304774600000000",
      kpp: SBER.kpp,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "kpp", code: "not_allowed_for_kind" });
  });

  it("accepts a sole proprietor with a 12-digit ИНН and a 15-digit ОГРНИП", () => {
    const result = validateCounterparty({
      kind: "sole_proprietor",
      name: "ИП Иванов И.И.",
      inn: "771234567859",
      ogrn: "304774600000000",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an individual without any requisites at all", () => {
    expect(validateCounterparty({ kind: "individual", name: "Иванов Иван Иванович" }).ok).toBe(true);
  });

  it("requires a non-RU country for a foreign counterparty and forbids Russian requisites", () => {
    const noCountry = validateCounterparty({ kind: "foreign", name: "ACME Inc." });
    expect(noCountry.ok).toBe(false);
    if (!noCountry.ok) {
      expect(noCountry.issues).toContainEqual({ field: "countryCode", code: "foreign_requires_non_ru_country" });
    }

    const withInn = validateCounterparty({ kind: "foreign", name: "ACME Inc.", countryCode: "us", inn: SBER.inn });
    expect(withInn.ok).toBe(false);
    if (!withInn.ok) {
      expect(withInn.issues).toContainEqual({ field: "inn", code: "not_allowed_for_kind" });
    }

    expect(validateCounterparty({ kind: "foreign", name: "ACME Inc.", countryCode: "us" }).ok).toBe(true);
  });

  it("reports a failed checksum separately from a malformed value", () => {
    const result = validateCounterparty({ ...legalEntity, inn: "7707083894" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "inn", code: "checksum_failed" });
  });

  it("rejects an unknown kind", () => {
    const result = validateCounterparty({ kind: "llc", name: "ООО Ромашка" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "kind", code: "invalid_kind" });
  });

  it("rejects an over-long name", () => {
    const result = validateCounterparty({ ...legalEntity, name: "О".repeat(301) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "name", code: "too_long" });
  });
});

describe("validateCounterparty - bank details", () => {
  const base = { kind: "legal_entity", name: "ПАО Сбербанк", inn: SBER.inn, kpp: SBER.kpp, ogrn: SBER.ogrn };

  it("accepts an account with its БИК and correspondent account", () => {
    const result = validateCounterparty({
      ...base,
      bankName: "ПАО Сбербанк",
      bankBic: SBER.bic,
      bankAccount: "40702810200000000001",
      corrAccount: SBER.corr,
    });
    expect(result.ok).toBe(true);
  });

  it("requires the БИК before an account can be checked", () => {
    const result = validateCounterparty({ ...base, bankAccount: "40702810200000000001" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "bankAccount", code: "bank_bic_required" });
  });

  it("rejects a settlement account placed in the correspondent account field", () => {
    const result = validateCounterparty({
      ...base,
      bankBic: SBER.bic,
      corrAccount: "40702810200000000001",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual({ field: "corrAccount", code: "not_a_correspondent_account" });
  });
});

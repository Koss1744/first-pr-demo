import {
  COUNTERPARTY_KINDS,
  isValidBankAccount,
  isValidBic,
  isValidEmail,
  isValidInn,
  isValidKpp,
  isValidOgrn,
  isValidPhone,
  normalizeCode,
  normalizeText,
  type CounterpartyKind,
  type FieldIssue,
} from "./requisites.js";

/** A validated, normalized counterparty ready to be written to the table. Optional fields are absent, never blank. */
export interface CounterpartyFields {
  kind: CounterpartyKind;
  name: string;
  fullName?: string;
  inn?: string;
  kpp?: string;
  ogrn?: string;
  countryCode: string;
  legalAddress?: string;
  postalAddress?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  bankName?: string;
  bankBic?: string;
  bankAccount?: string;
  corrAccount?: string;
  notes?: string;
}

export type ValidationResult = { ok: true; value: CounterpartyFields } | { ok: false; issues: FieldIssue[] };

const MAX_LENGTHS: Record<string, number> = {
  name: 300,
  fullName: 500,
  legalAddress: 500,
  postalAddress: 500,
  contactName: 200,
  bankName: 300,
  notes: 2000,
};

/**
 * Which registration identifiers each kind must, may, and must not carry.
 * Rejecting a КПП on an ИП (they are never issued one) catches the single most
 * common data-entry mistake in this kind of registry: pasting a whole block of
 * an organization's requisites onto a sole proprietor.
 */
const KIND_RULES: Record<
  CounterpartyKind,
  { inn: "required" | "optional" | "forbidden"; innLengths: number[]; kpp: "required" | "forbidden"; ogrn: "required" | "optional" | "forbidden"; ogrnLengths: number[] }
> = {
  legal_entity: { inn: "required", innLengths: [10], kpp: "required", ogrn: "required", ogrnLengths: [13] },
  sole_proprietor: { inn: "required", innLengths: [12], kpp: "forbidden", ogrn: "required", ogrnLengths: [15] },
  individual: { inn: "optional", innLengths: [12], kpp: "forbidden", ogrn: "forbidden", ogrnLengths: [] },
  foreign: { inn: "forbidden", innLengths: [], kpp: "forbidden", ogrn: "forbidden", ogrnLengths: [] },
};

/**
 * Validates and normalizes one counterparty as a whole.
 *
 * Updates validate the merged entity rather than just the changed fields: the
 * requisite rules are cross-field (a КПП is valid only next to a 10-digit ИНН,
 * an account only next to its БИК), so checking a patch in isolation would let
 * a legal entity be turned into an ИП while keeping its old КПП.
 */
export function validateCounterparty(raw: Record<string, unknown>): ValidationResult {
  const issues: FieldIssue[] = [];
  const reject = (field: string, code: string) => issues.push({ field, code });

  const kind = normalizeText(raw.kind) as CounterpartyKind | undefined;
  if (!kind || !COUNTERPARTY_KINDS.includes(kind)) {
    reject("kind", "invalid_kind");
  }

  const name = normalizeText(raw.name);
  if (!name) {
    reject("name", "required");
  }

  const text: Record<string, string | undefined> = {};
  for (const field of ["name", "fullName", "legalAddress", "postalAddress", "contactName", "bankName", "notes"]) {
    const value = normalizeText(raw[field]);
    if (value !== undefined && value.length > MAX_LENGTHS[field]) {
      reject(field, "too_long");
      continue;
    }
    text[field] = value;
  }

  const countryCode = (normalizeCode(raw.countryCode) ?? "RU").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    reject("countryCode", "invalid_country_code");
  }
  if (kind === "foreign" && countryCode === "RU") {
    reject("countryCode", "foreign_requires_non_ru_country");
  }

  const inn = normalizeCode(raw.inn);
  const kpp = normalizeCode(raw.kpp);
  const ogrn = normalizeCode(raw.ogrn);
  const rules = kind ? KIND_RULES[kind] : undefined;

  if (rules) {
    if (inn === undefined) {
      if (rules.inn === "required") reject("inn", "required");
    } else if (rules.inn === "forbidden") {
      reject("inn", "not_allowed_for_kind");
    } else if (!rules.innLengths.includes(inn.length)) {
      reject("inn", "wrong_length_for_kind");
    } else if (!isValidInn(inn)) {
      reject("inn", "checksum_failed");
    }

    if (kpp === undefined) {
      if (rules.kpp === "required") reject("kpp", "required");
    } else if (rules.kpp === "forbidden") {
      reject("kpp", "not_allowed_for_kind");
    } else if (!isValidKpp(kpp)) {
      reject("kpp", "malformed");
    }

    if (ogrn === undefined) {
      if (rules.ogrn === "required") reject("ogrn", "required");
    } else if (rules.ogrn === "forbidden") {
      reject("ogrn", "not_allowed_for_kind");
    } else if (!rules.ogrnLengths.includes(ogrn.length)) {
      reject("ogrn", "wrong_length_for_kind");
    } else if (!isValidOgrn(ogrn)) {
      reject("ogrn", "checksum_failed");
    }
  }

  const email = normalizeText(raw.email)?.toLowerCase();
  if (email !== undefined && !isValidEmail(email)) {
    reject("email", "malformed");
  }

  const phone = normalizeText(raw.phone);
  if (phone !== undefined && !isValidPhone(phone)) {
    reject("phone", "malformed");
  }

  const bankBic = normalizeCode(raw.bankBic);
  const bankAccount = normalizeCode(raw.bankAccount);
  const corrAccount = normalizeCode(raw.corrAccount);

  if (bankBic !== undefined && !isValidBic(bankBic)) {
    reject("bankBic", "malformed");
  }
  for (const [field, account] of [
    ["bankAccount", bankAccount],
    ["corrAccount", corrAccount],
  ] as const) {
    if (account === undefined) {
      continue;
    }
    if (bankBic === undefined) {
      reject(field, "bank_bic_required");
    } else if (!isValidBankAccount(account, bankBic)) {
      reject(field, "checksum_failed");
    }
  }
  // A correspondent account belongs to the bank itself and always sits on
  // balance account 301 - a settlement account pasted into this field would
  // otherwise pass the key check under the wrong prefix rule.
  if (corrAccount !== undefined && !corrAccount.startsWith("301")) {
    reject("corrAccount", "not_a_correspondent_account");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      kind: kind!,
      name: text.name!,
      fullName: text.fullName,
      inn,
      kpp,
      ogrn,
      countryCode,
      legalAddress: text.legalAddress,
      postalAddress: text.postalAddress,
      contactName: text.contactName,
      email,
      phone,
      bankName: text.bankName,
      bankBic,
      bankAccount,
      corrAccount,
      notes: text.notes,
    },
  };
}

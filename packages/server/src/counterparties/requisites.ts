/**
 * Counterparty requisites: normalization and validation of the Russian
 * registration identifiers a counterparty registry is keyed on - ИНН, КПП,
 * ОГРН/ОГРНИП, БИК and bank account numbers.
 *
 * Every check here is a pure function over strings so the rules can be unit
 * tested without a database, and so a caller can reuse a single check (e.g.
 * isValidInn) when importing a spreadsheet without going through the registry.
 * The checksum algorithms are the published ones from the ФНС (ИНН, ОГРН) and
 * the ЦБ РФ (account key), not heuristics.
 */

/**
 * legal_entity  - организация (10-digit ИНН, КПП, 13-digit ОГРН)
 * sole_proprietor - ИП (12-digit ИНН, 15-digit ОГРНИП, never a КПП)
 * individual    - физлицо, самозанятый (12-digit ИНН, optional)
 * foreign       - нерезидент, identified by country + registration number only
 */
export type CounterpartyKind = "legal_entity" | "sole_proprietor" | "individual" | "foreign";

export const COUNTERPARTY_KINDS: readonly CounterpartyKind[] = [
  "legal_entity",
  "sole_proprietor",
  "individual",
  "foreign",
];

/**
 * active   - can be used in new documents
 * blocked  - temporarily barred (failed compliance check, debt, suspicious activity)
 * archived - no longer worked with; kept for the document history that references it
 */
export type CounterpartyStatus = "active" | "blocked" | "archived";

export const COUNTERPARTY_STATUSES: readonly CounterpartyStatus[] = ["active", "blocked", "archived"];

/** One rejected field. `code` is a stable machine-readable reason, safe to map to a localized message. */
export interface FieldIssue {
  field: string;
  code: string;
}

function isDigits(value: string, length: number): boolean {
  return value.length === length && /^\d+$/.test(value);
}

function digitsOf(value: string): number[] {
  return value.split("").map((c) => Number(c));
}

function innCheckDigit(digits: number[], weights: number[]): number {
  const sum = weights.reduce((acc, weight, i) => acc + weight * digits[i], 0);
  return (sum % 11) % 10;
}

/**
 * ИНН: 10 digits for organizations, 12 for individuals and ИП, each ending in
 * ФНС check digits (one for the 10-digit form, two for the 12-digit one).
 */
export function isValidInn(inn: string): boolean {
  if (isDigits(inn, 10)) {
    const d = digitsOf(inn);
    return innCheckDigit(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  }
  if (isDigits(inn, 12)) {
    const d = digitsOf(inn);
    return (
      innCheckDigit(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] &&
      innCheckDigit(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11]
    );
  }
  return false;
}

/**
 * КПП: 9 characters - 4-digit tax office code, a 2-character reason code that
 * may contain the Latin letters A-Z (used for foreign organizations), then a
 * 3-digit serial.
 */
export function isValidKpp(kpp: string): boolean {
  return /^\d{4}[\dA-Z]{2}\d{3}$/.test(kpp);
}

/**
 * ОГРН (13 digits, organizations) and ОГРНИП (15 digits, ИП). The last digit is
 * the low digit of the preceding number modulo 11 (13-digit form) or 13
 * (15-digit form) - BigInt because the number does not fit a double exactly.
 */
export function isValidOgrn(ogrn: string): boolean {
  if (isDigits(ogrn, 13)) {
    const expected = BigInt(ogrn.slice(0, 12)) % 11n % 10n;
    return Number(expected) === Number(ogrn[12]);
  }
  if (isDigits(ogrn, 15)) {
    const expected = BigInt(ogrn.slice(0, 14)) % 13n % 10n;
    return Number(expected) === Number(ogrn[14]);
  }
  return false;
}

/** БИК: 9 digits; the Russian national bank codes all start with 04. */
export function isValidBic(bic: string): boolean {
  return isDigits(bic, 9) && bic.startsWith("04");
}

/**
 * 20-digit bank account, checked against its bank's БИК with the ЦБ РФ key
 * algorithm: prefix the account with three digits taken from the БИК (the RCC
 * code for a correspondent account, the bank's own suffix otherwise), then a
 * weighted digit sum over the resulting 23 digits must be divisible by 10.
 */
export function isValidBankAccount(account: string, bic: string): boolean {
  if (!isDigits(account, 20) || !isValidBic(bic)) {
    return false;
  }
  const prefix = account.startsWith("301") ? `0${bic.slice(4, 6)}` : bic.slice(6, 9);
  const digits = digitsOf(prefix + account);
  const weights = [7, 1, 3];
  const sum = digits.reduce((acc, digit, i) => acc + ((digit * weights[i % 3]) % 10), 0);
  return sum % 10 === 0;
}

/**
 * Deliberately permissive: one @, no spaces, a dot in the domain. Anything
 * stricter rejects addresses that real counterparties actually use, and this
 * server never sends mail - the field exists so a human can be reached.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** Phone as dialled: 5-15 digits (ITU E.164 maximum) after stripping +, spaces, dashes and brackets. */
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/[\s()+\-.]/g, "");
  return /^\d{5,15}$/.test(digits);
}

/** Collapses internal whitespace and trims; returns undefined for blank input so it lands in SQL as NULL. */
export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Same as normalizeText but also strips the spaces and dashes people paste inside ИНН/ОГРН/account numbers. */
export function normalizeCode(value: unknown): string | undefined {
  const text = normalizeText(value);
  return text === undefined ? undefined : text.replace(/[\s\-]/g, "").toUpperCase();
}

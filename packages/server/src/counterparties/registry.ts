import type pg from "pg";
import { recordAudit } from "../audit.js";
import type { Database } from "../db.js";
import { withTransaction } from "../db.js";
import { normalizeCode, type CounterpartyKind, type CounterpartyStatus, type FieldIssue } from "./requisites.js";
import { validateCounterparty, type CounterpartyFields } from "./validate.js";

interface CounterpartyRow {
  id: string;
  kind: CounterpartyKind;
  name: string;
  full_name: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  country_code: string;
  legal_address: string | null;
  postal_address: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  bank_name: string | null;
  bank_bic: string | null;
  bank_account: string | null;
  corr_account: string | null;
  status: CounterpartyStatus;
  notes: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

/** One counterparty as the API returns it: camelCase, nulls preserved so a cleared field is visible as null. */
export interface Counterparty {
  id: string;
  kind: CounterpartyKind;
  name: string;
  fullName: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  countryCode: string;
  legalAddress: string | null;
  postalAddress: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  bankName: string | null;
  bankBic: string | null;
  bankAccount: string | null;
  corrAccount: string | null;
  status: CounterpartyStatus;
  notes: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The writable fields, in the order the INSERT/UPDATE statements below use them. */
const FIELD_COLUMNS: ReadonlyArray<[keyof CounterpartyFields, string]> = [
  ["kind", "kind"],
  ["name", "name"],
  ["fullName", "full_name"],
  ["inn", "inn"],
  ["kpp", "kpp"],
  ["ogrn", "ogrn"],
  ["countryCode", "country_code"],
  ["legalAddress", "legal_address"],
  ["postalAddress", "postal_address"],
  ["contactName", "contact_name"],
  ["email", "email"],
  ["phone", "phone"],
  ["bankName", "bank_name"],
  ["bankBic", "bank_bic"],
  ["bankAccount", "bank_account"],
  ["corrAccount", "corr_account"],
  ["notes", "notes"],
];

const SELECT_COLUMNS = `id, kind, name, full_name, inn, kpp, ogrn, country_code, legal_address, postal_address,
       contact_name, email, phone, bank_name, bank_bic, bank_account, corr_account, status, notes,
       created_by, updated_by, created_at, updated_at`;

function toCounterparty(row: CounterpartyRow): Counterparty {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    fullName: row.full_name,
    inn: row.inn,
    kpp: row.kpp,
    ogrn: row.ogrn,
    countryCode: row.country_code,
    legalAddress: row.legal_address,
    postalAddress: row.postal_address,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    bankName: row.bank_name,
    bankBic: row.bank_bic,
    bankAccount: row.bank_account,
    corrAccount: row.corr_account,
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Turns a stored row back into validator input, so an update validates the merged entity (see validateCounterparty). */
function toRawFields(counterparty: Counterparty): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [field] of FIELD_COLUMNS) {
    raw[field] = counterparty[field as keyof Counterparty] ?? undefined;
  }
  return raw;
}

function fieldValues(fields: CounterpartyFields): unknown[] {
  return FIELD_COLUMNS.map(([field]) => fields[field] ?? null);
}

const UNIQUE_VIOLATION = "23505";

/** Escapes the LIKE wildcards so a search for "50%" looks for that text, not "50 followed by anything". */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isDuplicateInnKpp(err: unknown): boolean {
  const { code, constraint } = (err ?? {}) as { code?: string; constraint?: string };
  return code === UNIQUE_VIOLATION && constraint === "idx_counterparties_inn_kpp";
}

/** Finds the row that owns an (ИНН, КПП) pair - used to point a caller at the counterparty it collided with. */
async function findByInnKpp(db: pg.Pool | pg.PoolClient, inn: string, kpp: string | undefined): Promise<Counterparty | null> {
  const { rows } = await db.query<CounterpartyRow>(
    `SELECT ${SELECT_COLUMNS} FROM counterparties WHERE inn = $1 AND coalesce(kpp, '') = coalesce($2, '')`,
    [inn, kpp ?? null],
  );
  return rows[0] ? toCounterparty(rows[0]) : null;
}

interface CallContext {
  operator: string;
  clientId: string;
  ip?: string;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getCounterparty(db: Database, id: string): Promise<Counterparty | null> {
  const { rows } = await db.query<CounterpartyRow>(`SELECT ${SELECT_COLUMNS} FROM counterparties WHERE id = $1`, [id]);
  return rows[0] ? toCounterparty(rows[0]) : null;
}

export interface ListFilter {
  /** Free-text: matches a name substring, or an exact ИНН/ОГРН when the term is all digits. */
  search?: string;
  status?: CounterpartyStatus;
  kind?: CounterpartyKind;
  inn?: string;
  limit: number;
  offset: number;
}

export interface ListResult {
  items: Counterparty[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Search and page through the registry.
 *
 * Offset paging rather than the keyset cursor the audit log uses: a registry is
 * browsed by a human who jumps around pages and expects a total count, and the
 * table is small enough (tens of thousands of rows at most) that the offset
 * scan is cheaper than the machinery a stable cursor over a text sort needs.
 */
export async function listCounterparties(db: Database, filter: ListFilter): Promise<ListResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, ...params: unknown[]) => {
    for (const param of params) {
      values.push(param);
    }
    let i = values.length - params.length;
    conditions.push(sql.replace(/\?/g, () => `$${++i}`));
  };

  if (filter.status) add("status = ?", filter.status);
  if (filter.kind) add("kind = ?", filter.kind);
  if (filter.inn) add("inn = ?", filter.inn);
  if (filter.search) {
    const term = filter.search;
    // A digits-only term is a requisite, not a name fragment: matching it
    // exactly keeps "7707083893" from also dragging in every name that happens
    // to contain those digits.
    if (/^\d+$/.test(term)) {
      add("(inn = ? OR ogrn = ?)", term, term);
    } else {
      const pattern = `%${escapeLike(term)}%`;
      add("(name ILIKE ? ESCAPE '\\' OR full_name ILIKE ? ESCAPE '\\')", pattern, pattern);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await db.query<CounterpartyRow & { total_count: string }>(
    `SELECT ${SELECT_COLUMNS}, count(*) OVER () AS total_count
     FROM counterparties ${whereClause}
     ORDER BY lower(name), id
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filter.limit, filter.offset],
  );

  return {
    items: rows.map(toCounterparty),
    total: rows[0] ? Number(rows[0].total_count) : 0,
    limit: filter.limit,
    offset: filter.offset,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type CreateResult =
  | { outcome: "created"; counterparty: Counterparty }
  | { outcome: "invalid"; issues: FieldIssue[] }
  | { outcome: "duplicate"; existing: Counterparty | null };

export async function createCounterparty(
  db: Database,
  input: Record<string, unknown>,
  ctx: CallContext,
): Promise<CreateResult> {
  const validated = validateCounterparty(input);
  if (!validated.ok) {
    return { outcome: "invalid", issues: validated.issues };
  }
  const fields = validated.value;

  try {
    return await withTransaction(db, async (client) => {
      const columns = FIELD_COLUMNS.map(([, column]) => column);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const { rows } = await client.query<CounterpartyRow>(
        `INSERT INTO counterparties (${columns.join(", ")}, created_by, updated_by)
         VALUES (${placeholders.join(", ")}, $${columns.length + 1}, $${columns.length + 1})
         RETURNING ${SELECT_COLUMNS}`,
        [...fieldValues(fields), ctx.operator],
      );
      const counterparty = toCounterparty(rows[0]);

      await recordAudit(client, {
        eventType: "counterparty_create",
        username: ctx.operator,
        clientId: ctx.clientId,
        ip: ctx.ip,
        metadata: {
          counterparty_id: counterparty.id,
          name: counterparty.name,
          kind: counterparty.kind,
          inn: counterparty.inn,
          kpp: counterparty.kpp,
        },
      });

      return { outcome: "created" as const, counterparty };
    });
  } catch (err) {
    if (isDuplicateInnKpp(err)) {
      return { outcome: "duplicate", existing: await findByInnKpp(db, fields.inn!, fields.kpp) };
    }
    throw err;
  }
}

export type UpdateResult =
  | { outcome: "updated"; counterparty: Counterparty; changed: string[] }
  | { outcome: "not_found" }
  | { outcome: "invalid"; issues: FieldIssue[] }
  | { outcome: "duplicate"; existing: Counterparty | null };

/**
 * Applies a partial change. Keys absent from `patch` keep their stored value;
 * an explicit null clears the field - which is the only way to drop, say, a КПП
 * while changing kind from legal_entity to sole_proprietor in one request.
 */
export async function updateCounterparty(
  db: Database,
  id: string,
  patch: Record<string, unknown>,
  ctx: CallContext,
): Promise<UpdateResult> {
  try {
    return await withTransaction(db, async (client) => {
      // Read under a row lock: the merge below is a read-modify-write of the
      // whole row, so two patches touching different fields would otherwise
      // race and the slower one would write back the other's stale values.
      const current = await client.query<CounterpartyRow>(
        `SELECT ${SELECT_COLUMNS} FROM counterparties WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current.rows[0]) {
        return { outcome: "not_found" as const };
      }
      const existing = toCounterparty(current.rows[0]);

      const merged = toRawFields(existing);
      for (const [field] of FIELD_COLUMNS) {
        if (Object.hasOwn(patch, field)) {
          merged[field] = patch[field] ?? undefined;
        }
      }

      const validated = validateCounterparty(merged);
      if (!validated.ok) {
        return { outcome: "invalid" as const, issues: validated.issues };
      }
      const fields = validated.value;

      const changed = FIELD_COLUMNS.filter(
        ([field]) => (fields[field] ?? null) !== (existing[field as keyof Counterparty] ?? null),
      ).map(([field]) => field as string);

      const assignments = FIELD_COLUMNS.map(([, column], i) => `${column} = $${i + 1}`);
      const { rows } = await client.query<CounterpartyRow>(
        `UPDATE counterparties
         SET ${assignments.join(", ")}, updated_by = $${FIELD_COLUMNS.length + 1}, updated_at = now()
         WHERE id = $${FIELD_COLUMNS.length + 2}
         RETURNING ${SELECT_COLUMNS}`,
        [...fieldValues(fields), ctx.operator, id],
      );
      const counterparty = toCounterparty(rows[0]);

      await recordAudit(client, {
        eventType: "counterparty_update",
        username: ctx.operator,
        clientId: ctx.clientId,
        ip: ctx.ip,
        metadata: { counterparty_id: id, name: counterparty.name, changed },
      });

      return { outcome: "updated" as const, counterparty, changed };
    });
  } catch (err) {
    if (isDuplicateInnKpp(err)) {
      // The transaction rolled back, so re-derive the pair that collided the
      // same way the merge above did: patch value where given, stored value
      // otherwise. Only then can the caller be told which row it hit.
      const stored = await getCounterparty(db, id);
      const merged = (field: "inn" | "kpp") =>
        Object.hasOwn(patch, field) ? normalizeCode(patch[field]) : (stored?.[field] ?? undefined);
      const inn = merged("inn");
      return { outcome: "duplicate", existing: inn ? await findByInnKpp(db, inn, merged("kpp")) : null };
    }
    throw err;
  }
}

export type StatusResult =
  | { outcome: "ok"; counterparty: Counterparty; previousStatus: CounterpartyStatus }
  | { outcome: "not_found" };

/**
 * Moves a counterparty between active / blocked / archived. Every transition is
 * allowed (an archived counterparty comes back to life when work with it
 * resumes); the audit row is what records why. Rows are never deleted - invoices
 * and contracts reference them long after the relationship ends.
 */
export async function setCounterpartyStatus(
  db: Database,
  id: string,
  status: CounterpartyStatus,
  ctx: CallContext & { reason?: string },
): Promise<StatusResult> {
  return withTransaction(db, async (client) => {
    const current = await client.query<CounterpartyRow>(
      `SELECT ${SELECT_COLUMNS} FROM counterparties WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!current.rows[0]) {
      return { outcome: "not_found" as const };
    }
    const previousStatus = current.rows[0].status;

    const { rows } = await client.query<CounterpartyRow>(
      `UPDATE counterparties SET status = $1, updated_by = $2, updated_at = now()
       WHERE id = $3
       RETURNING ${SELECT_COLUMNS}`,
      [status, ctx.operator, id],
    );
    const counterparty = toCounterparty(rows[0]);

    await recordAudit(client, {
      eventType: "counterparty_status",
      username: ctx.operator,
      clientId: ctx.clientId,
      ip: ctx.ip,
      metadata: { counterparty_id: id, name: counterparty.name, from: previousStatus, to: status, reason: ctx.reason ?? null },
    });

    return { outcome: "ok" as const, counterparty, previousStatus };
  });
}

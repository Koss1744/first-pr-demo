-- Counterparty registry (реестр контрагентов): the organizations, sole
-- proprietors and individuals this company does business with, together with
-- the registration and bank requisites documents are drawn up from.
--
-- Kept in this database rather than a service of its own because the registry
-- is edited by the same internal back-office tooling that already holds a
-- scoped API key here, and because every edit has to land in the existing
-- audit_log to be reviewable alongside the rest of the operators' actions.
CREATE TABLE counterparties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('legal_entity', 'sole_proprietor', 'individual', 'foreign')),
  name            text NOT NULL,                  -- краткое наименование, as it appears in lists
  full_name       text,                           -- полное наименование, as it appears in contracts
  inn             text,                           -- 10 digits (organization) or 12 (ИП/физлицо); null for foreign
  kpp             text,                           -- 9 chars, organizations only - a branch differs from its head office only here
  ogrn            text,                           -- 13 digits, or 15 for ОГРНИП
  country_code    text NOT NULL DEFAULT 'RU' CHECK (country_code ~ '^[A-Z]{2}$'),
  legal_address   text,
  postal_address  text,
  contact_name    text,
  email           text,
  phone           text,
  bank_name       text,
  bank_bic        text,                           -- 9 digits
  bank_account    text,                           -- 20 digits, checksummed against bank_bic
  corr_account    text,                           -- 20 digits on balance account 301
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'archived')),
  notes           text,
  created_by      text NOT NULL,                  -- operator who added the row
  updated_by      text NOT NULL,                  -- operator who last changed it
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ИНН alone does not identify a counterparty: a branch carries its head
-- office's ИНН and is told apart only by its КПП, so identity is the pair.
-- COALESCE keeps rows without a КПП (ИП, физлица) comparable, since NULLs are
-- never equal to each other in a plain unique index and would let duplicates
-- through. The index is not restricted by status on purpose - an archived row
-- still owns its ИНН, so re-adding the same counterparty is a conflict the
-- caller has to resolve by reactivating the existing row.
CREATE UNIQUE INDEX idx_counterparties_inn_kpp ON counterparties (inn, coalesce(kpp, '')) WHERE inn IS NOT NULL;

-- Search in the registry is "by name within a status" far more often than
-- anything else; lower() matches the case-insensitive LIKE the list endpoint
-- issues, so prefix searches use the index instead of scanning.
CREATE INDEX idx_counterparties_status_name ON counterparties (status, lower(name));
CREATE INDEX idx_counterparties_name_lower ON counterparties (lower(name));

-- Registry edits are audited through the same append-only table as everything
-- else. For these three event types the audit row describes an object that is
-- not an AD user, so user_id stays null and username holds the operator who
-- made the change; the counterparty is identified in metadata.counterparty_id.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_event_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_event_type_check CHECK (event_type IN (
  'enroll_start', 'enroll_confirm', 'enroll_cancel',
  'verify_success', 'verify_fail', 'lockout', 'unlock',
  'admin_reset', 'admin_disable', 'admin_enable', 'client_auth_fail',
  'counterparty_create', 'counterparty_update', 'counterparty_status'
));

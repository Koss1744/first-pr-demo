-- One row per AD identity that has (or is enrolling) an MFA secret.
-- Lockout state lives here, not in a separate table, because it is always
-- read/written together with the user row in the same transaction.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL,                -- AD sAMAccountName, original case preserved
  display_name    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_count    integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX idx_users_username_lower ON users (lower(username));

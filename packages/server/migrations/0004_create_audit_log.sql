-- Append-only audit trail. username is denormalized (kept even after a user
-- row is deleted) so history survives account deletion; user_id is nullable
-- for the same reason.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  event_type    text NOT NULL CHECK (event_type IN (
                  'enroll_start', 'enroll_confirm', 'enroll_cancel',
                  'verify_success', 'verify_fail', 'lockout', 'unlock',
                  'admin_reset', 'admin_disable', 'admin_enable', 'client_auth_fail'
                )),
  user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  username      text,
  client_id     text NOT NULL,
  ip_address    inet,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_audit_log_user_id ON audit_log (user_id, occurred_at DESC);
CREATE INDEX idx_audit_log_occurred_at ON audit_log (occurred_at DESC);
CREATE INDEX idx_audit_log_event_type ON audit_log (event_type, occurred_at DESC);

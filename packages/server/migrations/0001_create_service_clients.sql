-- Internal service clients allowed to call this API (Credential Provider agent,
-- future OIDC interaction handler, admin tooling). Each carries its own scoped
-- API key so a compromised client can be revoked without affecting others.
CREATE TABLE service_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL UNIQUE,
  description     text NOT NULL,
  api_key_hash    bytea NOT NULL,               -- sha256(raw key)
  api_key_prefix  text NOT NULL,                -- first 8 chars of raw key, for log correlation only
  scopes          text[] NOT NULL DEFAULT '{}', -- e.g. {'verify'}, {'enroll','verify'}, {'admin'}
  disabled        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

CREATE INDEX idx_service_clients_client_id ON service_clients (client_id);

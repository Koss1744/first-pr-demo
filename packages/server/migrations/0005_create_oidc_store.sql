-- Generic key/value store backing the oidc-provider Adapter (see src/oidc/adapter.ts).
-- oidc-provider persists a dozen+ model kinds (Session, Interaction, Grant, AuthorizationCode,
-- AccessToken, RefreshToken, ...) that only ever need id lookup plus a handful of secondary
-- lookups (grant_id for cascade revocation, user_code for device flow, uid for session/interaction
-- lookup by cookie value) - one table with those columns pulled out of the JSONB payload covers
-- all of them without a migration per model kind.
CREATE TABLE oidc_model_store (
  model_name  text NOT NULL,
  id          text NOT NULL,
  payload     jsonb NOT NULL,
  grant_id    text,
  user_code   text,
  uid         text,
  expires_at  timestamptz,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_name, id)
);

CREATE INDEX idx_oidc_model_store_grant_id ON oidc_model_store (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX idx_oidc_model_store_user_code ON oidc_model_store (model_name, user_code) WHERE user_code IS NOT NULL;
CREATE INDEX idx_oidc_model_store_uid ON oidc_model_store (model_name, uid) WHERE uid IS NOT NULL;
CREATE INDEX idx_oidc_model_store_expires_at ON oidc_model_store (expires_at) WHERE expires_at IS NOT NULL;

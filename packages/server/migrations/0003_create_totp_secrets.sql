-- Envelope-encrypted TOTP secret, one per user. The actual secret is
-- encrypted under a random per-record data key (DEK); the DEK itself is
-- encrypted ("wrapped") under a root key selected by kek_version. Both
-- AES-256-GCM operations bind user_id as additional authenticated data,
-- so a row swapped between users fails auth-tag verification on decrypt
-- rather than silently decrypting under the wrong context.
CREATE TABLE totp_secrets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  algorithm           text NOT NULL DEFAULT 'SHA1' CHECK (algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  digits              smallint NOT NULL DEFAULT 6,
  period_seconds      smallint NOT NULL DEFAULT 30,

  kek_version         integer NOT NULL,
  wrapped_dek         bytea NOT NULL,
  wrapped_dek_iv      bytea NOT NULL,
  wrapped_dek_tag     bytea NOT NULL,
  secret_ciphertext   bytea NOT NULL,
  secret_iv           bytea NOT NULL,
  secret_tag          bytea NOT NULL,

  last_used_step      bigint,                   -- replay-protection watermark
  confirm_attempts    smallint NOT NULL DEFAULT 0, -- separate small cap for enroll/confirm, not shared with verify lockout
  enrolled_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,               -- null until the user proves possession

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

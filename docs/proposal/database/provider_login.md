# provider_login

**Question it answers:** which subscription sign-in is in flight, and what did the vendor issue?

```sql
CREATE TABLE provider_login (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('manual-code', 'device-code')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  instance_id TEXT NOT NULL,
  payload_ciphertext BLOB,
  payload_iv BLOB,
  payload_tag BLOB,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (payload_iv IS NULL OR length(payload_iv) = 12),
  CHECK (payload_tag IS NULL OR length(payload_tag) = 16),
  CHECK (
    (state = 'pending'
      AND payload_ciphertext IS NULL AND payload_iv IS NULL
      AND payload_tag IS NULL AND key_version IS NULL)
    OR (state = 'completed'
      AND payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL
      AND payload_tag IS NOT NULL AND key_version IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX provider_login_one_pending ON provider_login (provider) WHERE state = 'pending';
```

A login row is a suspended vendor handshake. It is `pending` while the live flow waits, `completed` after the vendor issues a credential, and consumed by deletion after registration or cancellation.

The payload holds the OAuth credential and the exact model ids, encrypted with the same master key as `provider`. The live flow is process-local, so `instance_id` records the daemon that holds it.

The partial unique index enforces one pending login per vendor.

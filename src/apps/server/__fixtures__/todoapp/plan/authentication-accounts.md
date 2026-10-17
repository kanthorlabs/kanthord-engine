---
node: authentication.md
bindings: []
verifications:
  - node --test test/authentication-accounts.test.js
---

# Store password-protected accounts without role escalation

## Requirement

Provide public `POST /api/v1/auth/register` and `POST /api/v1/auth/login`. Use Zod strict request schemas. Hash passwords with asynchronous scrypt, a unique random salt per password and timing-safe comparison. Use at least N=131072, r=8, p=1 with sufficient explicit memory allowance. Store algorithm, parameters, salt and derived key in `password_hash`. Expose only safe user projections. Use `user` and `admin` as the closed code enum for roles.

Registration accepts only `email` and `password`. It trims and lowercases the email, creates role `user`, and returns 201 with safe user fields and no session. Email is valid and at most 254 characters. Password has 12 through 128 characters and at most 512 UTF-8 bytes. Never trim or normalize the password. A duplicate email returns 409. Login returns 200. An unknown email and an incorrect password return the same safe 401 error, with a dummy hash comparison for unknown accounts.

Supply a documented operator-only CLI that provisions the initial administrator. It reads the password from hidden input or stdin, never from a command argument or log. No HTTP route can choose or change role. Create `src/modules/auth` with this code.

## Criterion

- Successful registration returns 201 with `id`, `email`, `role`, `created_at`; the role is always `user` and no session is issued.
- Registration accepts only `email` and `password` and trims and lowercases the email. Strict schemas reject unknown properties, including `role`, `user_id` and stored-secret fields, with 400.
- Duplicate normalized email returns 409. Malformed email, email over 254 characters, password bounds (12 through 128 characters, at most 512 UTF-8 bytes) and extra fields return 400. A failed registration writes no account and no session.
- Passwords are never trimmed or normalized.
- `password_hash` stores algorithm, parameters (at least N=131072, r=8, p=1), salt and derived key, hashed asynchronously with scrypt and compared timing-safe.
- The same password for two users produces distinct stored hashes. Tests verify actual password matching and mismatching, not mocked crypto success.
- Login returns 200. Unknown-account login and wrong-password login share status 401, code and public message. Unknown accounts still perform a password derivation comparison.
- Password hashes are absent from logs and ordinary user responses.
- Administrator provisioning does not accept passwords in command arguments, reads hidden input or stdin, does not log passwords and does not silently elevate an existing normal account. No HTTP route can choose or change role.
- `user` and `admin` are the only roles, defined as a closed code enum.

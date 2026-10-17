---
node: foundation.md
bindings: []
verifications:
  - node --test test/foundation-configuration.test.js
---

# Validate explicit application configuration

## Requirement

Parse and validate runtime configuration once before startup. Validate these settings: `NODE_ENV`, `HOST`, `PORT`, `DATABASE_PATH`, `CORS_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL` and `SESSION_TTL_SECONDS`. Supply a safe `.env.example` and document defaults without committing secrets. Keep proxy trust explicit and disallow blanket production trust of arbitrary proxies.

## Criterion

- Configuration validates `NODE_ENV`, `HOST`, `PORT`, `DATABASE_PATH`, `CORS_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL` and `SESSION_TTL_SECONDS` at startup.
- Defaults are port 3000, no trusted proxy, no cross-origin access and session TTL 86400 seconds.
- Unsafe or invalid production configuration fails startup.
- Tests cover missing required production values, invalid ports, invalid log levels, nonpositive or excessive session lifetimes, malformed origins and invalid database paths.
- `SESSION_TTL_SECONDS` accepts 60 through 604800 seconds and defaults to 86400 seconds.
- Production requires an explicit writable persistent database path. Tests use temporary paths, not the example production path.
- No origin is allowed by default. Credentialed CORS is disabled because authentication uses explicit bearer headers, not cookies.
- Proxy trust defaults to false; configured trusted proxy addresses are validated. Configuration failure happens before listening and names the bad setting without disclosing its value when sensitive.

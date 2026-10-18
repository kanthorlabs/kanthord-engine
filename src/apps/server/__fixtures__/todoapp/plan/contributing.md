---
work: implement
depends_on:
  - foundation.md
bindings:
  - todoapp-repo
verifications:
  - test -f LICENSE && grep -q "MIT License" LICENSE
  - test -f CONTRIBUTING.md && grep -q "npm run verify" CONTRIBUTING.md
  - npm ci && npm run format:check
---

# Add the license and the contribution guide

## Requirement

Add an MIT `LICENSE` file at the repository root. Add a `CONTRIBUTING.md` that states the supported Node.js version, the setup with `npm ci` and the check with `npm run verify` before a pull request.

## Criterion

- `LICENSE` holds the MIT License text with the current year and the owner `kanthorlabs`.
- `CONTRIBUTING.md` names Node.js 24, `npm ci` and `npm run verify`, and it states that a pull request passes `npm run verify`.
- No other file changes.

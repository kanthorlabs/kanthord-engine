# JWT acceptance checks

[Internal documentation home](README.md)

From the engine repository root, run:

```sh
pnpm run test:e2e:jwt
```

The runner requires Python 3 with POSIX PTY support. It builds the engine, starts a disposable loopback server, generates default and custom-username JWTs using the compiled CLI, and exercises API and CLI verification. Missing, tampered, expired, wrong-key, and malformed tokens must fail.

It also verifies an environment-supplied token without login, checks the published verification and worker-registration contracts, proves that redirected server startup prints no token, stops the server, and removes disposable state.

Sanitized proof is written under the workspace's `.dev/e2e/<YYMMdd>-jwt-verification/`, with a suffix for repeat runs. The proof includes decoded claims, status codes, exit codes, process provenance, and cleanup checks. The proof excludes raw JWTs, client secrets and master keys. The runner reads
the machine `token:` and `clientSecret:` lines from a PTY. It checks that the
client secret has the canonical 32-byte base64 form. The sentinel sweep checks
every evidence file for both values.

Source: [acceptance runner](../scripts/e2e-jwt.py). General validation commands and documentation checks are in [AGENTS.md](../AGENTS.md).

# Story 02 — Config discovery and the packaged entry point

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: Story 01.

## Change

**1. `src/domain/version.ts`** — new file, the one version constant.

```ts
export const KANTHORD_VERSION = "27.8.1";
```

**2. `src/services/config/search-order.ts`** — new file, pure.

```ts
export type SearchOrderInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homeDir: string;
  etcDir: string;
}>;

export function searchOrder(input: SearchOrderInput): readonly string[];
```

It returns exactly four absolute paths, in this order, and never reads the file system:

1. `input.env.KANTHORD_CONFIG` when it is set and non-empty, resolved against `input.cwd`.
2. `join(input.cwd, "kanthord.config.json")`.
3. `join(input.env.XDG_CONFIG_HOME ?? join(input.homeDir, ".config"), "kanthord", "config.json")`.
4. `join(input.etcDir, "kanthord", "config.json")`.

`etcDir` is an argument so that a unit test never depends on whether the host has `/etc/kanthord/config.json`. `src/main.ts` passes the literal `"/etc"`, and it is the only caller that does.

When `KANTHORD_CONFIG` is unset the list holds three paths. The order never changes and no entry is deduplicated.

**3. `src/services/config/index.ts`** — change `LoadInput`:

```ts
export type LoadInput = Readonly<{
  explicitConfigPath?: string;
  homeOverride?: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homeDir: string;
  etcDir: string;
}>;
```

**4. `src/services/config/convict.ts`** — replace step 1 of `load` (Story 01) with:

- `input.explicitConfigPath` present and non-empty: the candidate list is `[resolve(input.cwd, input.explicitConfigPath)]`. It never falls through to the search order.
- Otherwise the candidate list is `searchOrder(input)`.
- Walk the list in order and take the first path where `fs.existsSync` is true.
- No candidate exists: throw `ConfigError("config-not-found", "no config file found; searched: " + candidates.join(", "))`.
- `discovery.searched` is the whole candidate list in order, whichever one resolved.

**5. `src/main.ts`** — replace the entire file (`src/main.ts:1` is `console.log("Hello, World!");`).

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { KANTHORD_VERSION } from "./domain/version.ts";

const program = new Command()
  .name("kanthord")
  .version(KANTHORD_VERSION)
  .option("--config <path>", "path to the configuration file")
  .option("--home <path>", "override the configured daemon home");

await program.parseAsync(process.argv);
```

Story 07 adds the `serve` command to this program and the composition root beneath it. Add nothing else here now.

**6. `package.json`** — add `bin` after `"packageManager"`:

```json
"bin": { "kanthord": "./src/main.ts" }
```

Do not change `"scripts"`. Story 09 owns `verify`.

**7. The executable bit** — `chmod +x src/main.ts`, and commit the mode. A `bin` target with a shebang and no executable bit fails on an install that does not rewrite the mode, and the Proof invokes `./src/main.ts` directly to catch it.

## Constraints

- `src/domain/version.ts` stays pure: no import at all.
- `searchOrder` reads no file system and no `process.env`. Every input arrives as an argument.
- `--config` that names a missing file refuses with `config-not-found` on that path. It must never search the other locations, because a typed path silently falling back to `/etc` is the failure this order exists to prevent.
- The shebang is the first line of `src/main.ts`, with no blank line above it.

## Verify

`node --test src/domain/version.test.ts`, which asserts, reading `package.json` with `readFileSync(new URL("../../package.json", import.meta.url), "utf8")`:

- `KANTHORD_VERSION` equals the `version` field. This is the only guard against the literal drifting.
- `bin` holds exactly one key, `kanthord`, and its value is `./src/main.ts`.
- That target exists, `statSync(target).mode & 0o111` is non-zero, and the file's first line is exactly `#!/usr/bin/env node`. This is as far as a unit test reaches: `npm pack`, the install and the linked `kanthord` name belong to P1-E1 in EPIC 011.

`node --test src/services/config/search-order.test.ts`, which asserts:

- With an empty `env` and `etcDir: "/fixture-etc"`, the result is exactly `[join(cwd, "kanthord.config.json"), join(homeDir, ".config/kanthord/config.json"), "/fixture-etc/kanthord/config.json"]`, deep-equal and in that order. Every case passes a fixture `etcDir`, so no assertion reads the host's `/etc`.
- `KANTHORD_CONFIG=/tmp/a.json` prepends that path, giving four entries.
- `KANTHORD_CONFIG=rel.json` resolves against `cwd`.
- `XDG_CONFIG_HOME=/xdg` replaces the third entry with `/xdg/kanthord/config.json`.
- `KANTHORD_CONFIG=""` is treated as unset.

`node --test src/services/config/convict.test.ts` gains:

- A config file at `join(cwd, "kanthord.config.json")` loads with no `explicitConfigPath`, and `discovery.resolved` names it.
- With the same file present, `KANTHORD_CONFIG` pointing at a second valid file wins, and `discovery.resolved` names the second file.
- No file at any candidate throws `config-not-found`, and the message holds every candidate path, comma-space joined, in search order.
- `explicitConfigPath` naming a missing file throws `config-not-found` naming that path, and the message holds no other path, even when a valid `kanthord.config.json` sits in `cwd`.
- `discovery.searched` for a resolved search-order load holds all three candidates, not only the resolved one.

Command check, run by hand once and by the Proof every time:

- `./src/main.ts --version` prints `27.8.1` and exits 0, through the shebang and the executable bit rather than through `node`.
- `./src/main.ts --help` exits 0 and names `--config` and `--home`.

`npm run verify` exits 0.

Proof: `PASS 001-CONFIG`, `PASS 001-ENTRY`.

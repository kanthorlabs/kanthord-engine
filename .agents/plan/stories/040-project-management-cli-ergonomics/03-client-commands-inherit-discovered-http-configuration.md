# Story 3 — Client commands inherit discovered HTTP configuration

Epic: `.agents/plan/epics/040-project-management-cli-ergonomics.md`
Depends on: Story 2 only by dispatch order.

## Change

### `src/cli/options.ts:7-106`

- Add exported type `ClientConfigDefaults = Readonly<{ bind: string; port: number; token: string }>`.
- Add exported pure function `clientBaseUrl(defaults: ClientConfigDefaults): string`:
  - `0.0.0.0` uses host `127.0.0.1`;
  - `::` uses host `[::1]`;
  - a bind already enclosed by `[` and `]` stays enclosed once;
  - every other bind containing `:` is enclosed in brackets;
  - every other bind is unchanged;
  - return `http://<host>:<port>`.
- Extend `ResolveInput` at `:29-32` with optional `loadConfig: () => ClientConfigDefaults | undefined`.
- Preserve direct-token/token-file conflict and token-file mode checks exactly.
- After resolving flag/environment token and token-file input, call `loadConfig` at most once and only when either the normalized base URL or normalized token is absent. Do not call it when both are supplied.
- Resolve each missing value independently. Base URL is flag, environment, then `clientBaseUrl(config)`. Token is direct flag/environment or token-file flag/environment, then `config.token`. Treat an empty config token as absent.
- Change `requireBaseUrl` at `:108-115` to say `no daemon base url; set --base-url, KANTHORD_BASE_URL or a discovered config`.
- Extend `registerClientOptions` with top-level help text naming exactly `KANTHORD_BASE_URL`, `KANTHORD_TOKEN`, `KANTHORD_API_TOKEN_FILE` and the precedence sentence `Client connection precedence: flags > environment > discovered config.`

### `src/cli/program.ts:50-111`

- Add `loadClientConfig: (options: ServeOptions) => ClientConfigDefaults | undefined` to `ProgramDependencies` at `:55-74`.
- In `clientFactory` at `:104-111`, read global `config` and `home` options and pass a zero-argument closure to `resolveClientOptions`; the closure calls `dependencies.loadClientConfig({ config, home })`.
- Keep the callback lazy through `resolveClientOptions`. No command registration changes in this story.

### `src/main.ts`

- Add a module-local `loadClientConfig(options: ServeOptions): ClientConfigDefaults | undefined` between `serve` (`src/main.ts:188`) and `migrate` (`src/main.ts:709`), using `new ConvictConfig().load` with the same `env`, `cwd`, `homedir()` and `/etc` inputs as the load at `src/main.ts:190-197` and the same `config`/`home` overrides.
- Return only `settings.http.bind`, `settings.http.port` and `settings.http.token`.
- When `error instanceof ConfigError && error.code === "config-not-found"`, return `undefined` only when both `options.config` and `process.env.KANTHORD_CONFIG` are absent or empty. Re-throw an explicit-path miss and every other config error.
- Pass this callback in the `buildProgram` dependency object at `src/main.ts:794-816`.
- Import `ClientConfigDefaults` as a type from `src/cli/options.ts`; `cli/` must not import `services/config`.

### Other `ProgramDependencies` construction sites

- Add a no-read `loadClientConfig: () => undefined` default to `src/cli/program.test.ts`'s fake dependencies, `src/cli/parity.test.ts`'s fake dependencies and `test/helpers/command-recorder.ts:128-183`.
- In tests that exercise config fallback, replace that default with a recording callback; do not weaken the required dependency to optional.

### Help and proposal

- In `src/cli/config/index.ts:3-12`, change the first help line to `Configuration search order for daemon start and client fallback:` and the last to `The daemon and a local client fallback load the first candidate that exists.` Keep all five candidates and their order.
- In `docs/proposal/phase-1/transport.md`, insert `## CLI connection resolution` after the opening surface section at `:10` and before the transport-core section. State the per-value precedence, lazy-load rule, bind rendering, environment names and that config fallback is local HTTP discovery only.
- Run Prettier on the proposal file.

## Constraints

- `src/cli/**` imports no service implementation.
- `--help`, `--version`, `config generate`, `plan convert` and a complete flag/environment client call read no config.
- Keep mode `0600` enforcement for API token files.
- Do not add HTTPS inference; the daemon terminates no TLS.
- `db migrate` keeps its loopback refusal through the same resolved client options.

## Verify

- Extend `src/cli/options.test.ts`:
  - pin `clientBaseUrl` for `127.0.0.1`, `0.0.0.0`, `::`, `::1`, `[::1]` and `daemon.test`;
  - table-drive flag > env > config independently for base URL and token;
  - assert config fills only the missing member;
  - assert a complete flag/environment pair calls the loader zero times and a fallback calls it once;
  - keep direct-token/token-file conflict, missing-file and mode tests unchanged;
  - assert the revised missing-base message and top-level environment help exactly.
- Extend `src/cli/program.test.ts` with a recording `loadClientConfig`; parse `status` without client flags and assert the request uses the callback's base URL and token. Parse `--help` and assert zero loader calls.
- Extend `src/cli/config/index.test.ts` with the two revised sentences and the unchanged five-candidate order.
- Extend `src/main.test.ts`:
  - retain the generated config path from the `before` hook at `:233-251`;
  - while the daemon is live, run `status` with `cwd` equal to the config directory, no `--base-url`, no token flag and empty client environment;
  - assert exit 0 and the ordinary status output;
  - add a second run with an explicit `--config <path>` from another temporary cwd and assert the same result.
- Update `src/cli/parity.test.ts` and `test/helpers/command-recorder.test.ts` only as required by the new required dependency; their existing behavior assertions remain unchanged.
- `node --test src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/parity.test.ts test/helpers/command-recorder.test.ts src/main.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: the options, program, config, parity, recorder and main test lines of the EPIC Proof; the final sentinel is delivered collectively.

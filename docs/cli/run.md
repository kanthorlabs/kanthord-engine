# Run Commands

This specification for `kanthord run` contains **1 command leaf: 1 implemented**.
Start with [the CLI specification index](./README.md) and
[shared CLI conventions](./other.md).

## Command inventory

1. `kanthord run agent <agent-name> [--model <value>] [--workspace <path>] [--session <path>] [--prompt <value>]... [--system-prompt <value>]... [--auth <path>] [--budget <value>]... [--output <path|stdout>]` — implemented; local agent run, no route.

## Try it

The script `scripts/play-run-agent.mjs` sets up a private play directory, starts the agent and prints the result:

```sh
pnpm run play:agent -- [--repo <path>] [--model <provider>/<model>:<level>] [--auth <path>] [--budget <duration>] [--no-refresh] [--no-build] [--refresh-only] ["<prompt>"]
```

| Option           | Default                              | Effect                                                                  |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `--repo`         | none                                 | Clone this git repository. With no value, use the sample.               |
| `--model`        | `anthropic/claude-sonnet-5-5:medium` | The model of each run.                                                  |
| `--auth`         | `~/.config/kanthord/auth.json`       | The `--auth` file of each run.                                          |
| `--budget`       | `15m`                                | The wall budget of each run.                                            |
| `--no-refresh`   | refresh on                           | Skip the pi token refresh before each run.                              |
| `--no-build`     | build check on                       | Skip the build check.                                                   |
| `--refresh-only` | run on                               | Refresh and prepare the play directory; print its path and exit `0`.    |
| `"<prompt>"`     | use `prompt.md`                      | Prompt text or a path, as one argument. With no value, use `prompt.md`. |

The play directory is `<state directory>/play/<YYYYMMDD>` with mode `0700`. The script uses the local date, so the same directory is reused on the same day. It holds `workspace/`, `prompt.md`, `sessions/`, `result.jsonl` and `run.sh`.

The script refuses a play directory that is a symbolic link, that another user owns or whose mode is not `0700`. It refuses a `play` parent directory that is a symbolic link or that another user owns.

When `workspace/` is absent, the script creates the workspace (sample or `--repo` clone) and writes `prompt.md`. On a reuse of the same day, the script keeps `workspace/` and `prompt.md` unchanged and adds a new session file. Start one call at a time for one play directory.

The script refuses a prompt in more than one argument. A relative prompt path resolves against the play directory.

The script verifies that `dist/main.js` is present and not older than each `.ts` file of `src/`. When either condition fails, it runs `pnpm run build` first, with the build output on stderr. Use `--no-build` to skip this check.

Unless `--no-refresh` is given, the script calls `ModelRuntime.create` and `getAuth` from `@earendil-works/pi-coding-agent` to refresh an `oauth` entry. The entry type comes from `listCredentials` of pi, which resolves no key. An `api_key` entry or an absent entry gets no refresh, so the script runs no `!` command and resolves no `$` reference of a key. The refresh requires a token validity of the budget plus 10 minutes. The result is discarded. Before the refresh, the script refuses these conditions with one fixed line on stderr and exit `1`:

- `NODE_USE_ENV_PROXY` is set, or `--use-env-proxy` is in `NODE_OPTIONS` or in the Node arguments.
- The `--auth` file is absent, is no regular file, has another owner or has a group or other mode bit.

On a failed refresh, the script prints one fixed error line to stderr and exits `1`. The `play:agent` script sets `ulimit -c 0` before it starts Node, and `run.sh` sets it again.

Each run writes a new session file in `sessions/` and appends a result line to `result.jsonl`.

The script prints the play directory, the path of `run.sh`, and after the run: the exit code, the `end`, `class` and `text` fields of the new result line and the workspace status. A run with no new result line prints no result field.

## `run agent`

**Implemented:** `run agent` runs one agent profile on one workspace for one
turn. It calls no server and reads no standard input. It writes one session
file and reports one result.

### Options

| Option or operand                    | Rule                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `<agent-name>`                       | Required. One profile name of the runtime catalog, for example `swe@1` or `re@1`.                              |
| `--prompt <text\|path>`              | Required and repeatable. Each value is one prompt part, in order.                                              |
| `--system-prompt <text\|path>`       | Optional and repeatable. Each value is one context part after the profile prompt. It never replaces that text. |
| `--model <provider>/<model>:<level>` | Required. The provider, the model id and the reasoning level. No default exists.                               |
| `--budget <duration\|Nusd>`          | Optional and repeatable: one wall budget, one cost budget, or both. Default wall budget `2h`.                  |
| `--workspace <path>`                 | Optional. The working directory of the session. Default: the current directory.                                |
| `--session <path>`                   | Required. The path of the new session file.                                                                    |
| `--auth <path>`                      | Optional. A file in the pi `auth.json` format. Default: `.config/kanthord/auth.json` in the OS user home.      |
| `--output <stdout\|path>`            | Optional. Default `stdout`: a text result. A path: one JSON line per run, appended to that file.               |

- The run checks the operand and the required options itself and refuses an
  absent one with `cli.run.agent.option_invalid` and the `option` row.
- A single-value option given twice gives `cli.option.duplicate`.
- The run refuses `--token` with `cli.run.agent.token` before each other check.
- The run refuses `NODE_USE_ENV_PROXY`, and `--use-env-proxy` in `NODE_OPTIONS`
  or in the Node arguments, with `cli.run.agent.env_proxy`.
- The run refuses an unknown profile name with `cli.run.agent.agent_unknown`.

### Text or path

A `--prompt` or `--system-prompt` value is a path only when it looks like a
path. A value looks like a path when it holds no line break, has 1 to 4096
bytes, and one of these conditions holds:

- it starts with `/`, `./` or `../`;
- it holds no whitespace and holds a `/`;
- it holds no whitespace and ends with `.` and 1 to 8 ASCII letters or digits.

Each other value is text. To read the file `README`, write `./README`.

1. When no entry exists at the path, the value is text. The run writes one
   notice line on stderr: `{"code":"cli.run.agent.prompt_text_path","msg","option","index"}`.
   `index` counts the values of that option from 1. The line holds no value.
2. The run refuses the `--auth` file, a path in the KanthorD configuration
   directory and a path in the pi directory with `cli.run.agent.auth_place`.
3. The run refuses a path under `/dev` or `/proc` with
   `cli.run.agent.prompt_place`.
4. The run reads an existing entry as UTF-8 text. It refuses an entry that is
   no regular file with `cli.file.not_regular` and text that is not UTF-8 with
   `cli.file.encoding_invalid`.
5. The run removes each final line break of each part. A part with no text adds
   nothing. The user message is the `--prompt` parts joined with one blank
   line. With no text in all parts, the run refuses with
   `cli.run.agent.prompt_missing`.

### Model selection

The run resolves the `--model` value with the pi model resolver and accepts
only an exact match.

- `cli.run.agent.option_invalid`, `option: --model`: the value has no `/`, no
  `:` after the `/`, an empty model, an unknown provider, the provider
  `anthropic-subscription` or an unknown level.
- `cli.run.agent.model_unknown`: the model runtime holds no such model.
- `cli.run.agent.model_inexact`: the resolved provider, id or level differs
  from the value.
- `cli.run.agent.level_unsupported`: the model does not support the level.

The levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

### Budget

The `--budget` option gives one wall budget, one cost budget, or both.

- **Wall budget.** A positive integer with `s`, `m` or `h`, for example `30m`
  or `1h`. Default `2h`.
- **Cost budget.** A positive decimal with at most 6 fraction digits and the
  suffix `usd`, for example `5usd` or `0.25usd`. The cost is the list price:
  the sum of `usage.cost.total` of each assistant message of the run.

The first limit the run reaches ends the current turn with the end `budget_end`
and exit `4`. The result field `budget_reached` is `wall` or `usd`.

- The run compares the cost with the cost budget after each assistant message.
  One model call can thus pass the cost budget. The run sends no model request
  after a limit.
- A provider error that comes before a limit keeps the end `failed`.
- With no cost budget, the run has no cost limit.
- The run refuses a cost budget when the resolved model has no price, with
  `cli.run.agent.budget_unpriced`, `option: --budget`. An `openai-compatible`
  model has no price.
- The run refuses a zero value, a value of no kind and a second value of one
  kind with `cli.run.agent.option_invalid`, `option: --budget`.
- The wait of each pi retry counts against the wall budget.

### The `--auth` file

The `--auth` file is the only credential source of the run. The run reads the
entry of the selected provider with the pi reader and writes nothing to the
file.

| Code                                | Condition                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `cli.run.agent.auth_file_invalid`   | The path is absent, a symbolic link or no regular file; the file holds no valid JSON object; or no default path exists. |
| `cli.run.agent.auth_file_owner`     | Another user owns the file.                                                                                             |
| `cli.run.agent.auth_file_mode`      | The mode has a group or other bit.                                                                                      |
| `cli.run.agent.auth_place`          | The file is inside the workspace.                                                                                       |
| `cli.run.agent.auth_entry_missing`  | The file holds no entry of the provider.                                                                                |
| `cli.run.agent.auth_entry_invalid`  | An entry fails its schema, the provider shape or the metadata schema. Row: `field`.                                     |
| `cli.run.agent.auth_key_command`    | The `key` starts with `!`.                                                                                              |
| `cli.run.agent.auth_key_reference`  | The `key` holds `$`.                                                                                                    |
| `cli.run.agent.credential_expiring` | An `oauth` entry expires before the wall deadline plus 5 minutes.                                                       |

The run applies the entry schema to every entry of the file. A failed schema
gives the `field` row `<provider>` or `<provider>.<path>`. Each other check
applies only to the entry of the selected provider.

An `api_key` entry holds `type`, `key` and an optional `env` object. The `env`
object holds exactly the routing names of the provider:

| Provider                | Names in `env`                                           |
| ----------------------- | -------------------------------------------------------- |
| `openai-compatible`     | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODELS` |
| `amazon-bedrock`        | `AWS_REGION`                                             |
| `google-vertex`         | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`          |
| `azure`                 | `AZURE_OPENAI_RESOURCE_NAME`                             |
| `cloudflare-workers-ai` | `CLOUDFLARE_ACCOUNT_ID`                                  |
| `cloudflare-ai-gateway` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`         |
| Each other provider     | none                                                     |

`OPENAI_COMPATIBLE_MODELS` is the JSON text of the model array. For the
provider `anthropic`, an `oauth` entry selects the subscription.

Each credential value of the entry is a known secret of the run.

### Session file

The run creates the session file at the `--session` path with mode `0600`. The
checks run before the session opens.

| Code                                      | Condition                                              |
| ----------------------------------------- | ------------------------------------------------------ |
| `cli.run.agent.session_exists`            | An entry exists at the path, a symbolic link included. |
| `cli.run.agent.session_directory_invalid` | The parent directory is absent or no directory.        |
| `cli.run.agent.session_directory_owner`   | Another user owns the parent directory.                |
| `cli.run.agent.session_directory_mode`    | The parent directory has a group or other write bit.   |
| `cli.run.agent.session_place`             | The path is inside the workspace or the pi directory.  |

- No input entry of the session file holds a known secret. The redaction marker
  takes its place.
- The session file keeps LLM output unchanged. When LLM output holds a known
  secret, stderr gets one JSON line with the code
  `cli.run.agent.secret_exposed`, the `rule` and the `count`. Rotate that
  credential.
- The run blocks a tool call whose input holds a known secret.

### Start preconditions

Each profile declares a list of start preconditions. The run checks each one
before it opens the session, sends a request or writes any file. A failed
precondition gives `cli.run.agent.start_refused` with a `reason` row that
starts with the precondition id.

| Id                    | Condition                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `workspace_directory` | The working directory and each root are directories that exist.                                                       |
| `git_worktree`        | For each root, `git rev-parse --show-toplevel` exits `0` and prints the real path of the root.                        |
| `git_clean`           | For each root, `git --no-optional-locks status --porcelain=v1 --untracked-files=normal` exits `0` and prints nothing. |

- `swe@1` checks all three. `re@1` and `env@1` check only `workspace_directory`.
- `git_worktree` requires the root to be the top level of its worktree. A
  subdirectory of a worktree fails.
- `git_clean` checks for uncommitted changes and untracked files. Any output
  from the command fails the check.
- Each git command runs with an isolated environment. The environment contains
  only the names of `childEnvironment` plus `PATH`. It sets
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`, so the check runs no
  hook and no fsmonitor command. Filter drivers run as configured.
- `--no-optional-locks` stops the refresh write of the index. The check changes
  no file of the workspace.
- The check differs from a `git status` of the developer. The global ignore
  file and the global filter drivers are absent. A file that only a global
  ignore rule covers is thus an uncommitted change.
- An ignored file is no uncommitted change.
- Each `git` command has a deadline of 30 seconds. A timeout fails the
  precondition.
- The `reason` row holds no path.

### Directories and environment

- The pi directory is `kanthord/pi` under the KanthorD XDG state directory. The
  run refuses a pi directory that is no directory, is a symbolic link or has
  another owner with `cli.run.agent.pi_directory_invalid`.
- The run refuses an `auth.json` in the pi directory with
  `cli.run.agent.auth_in_pi_directory`, before the pi tool install.
- The run refuses a failed pi tool install with
  `cli.run.agent.tool_install_failed`.
- The run makes one run directory in `TMPDIR` and removes it before the exit.
  `HOME` and `TMPDIR` of the process point into it during the run.
- The run removes the ambient credential names and the proxy names
  `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`, in upper and lower
  case, from its environment.
- A child process of a tool gets only `PATH`, `LANG`, `TMPDIR`, `HOME`,
  `GIT_CONFIG_NOSYSTEM` and `GIT_SSH_COMMAND`.
- The run loads no extension, skill, prompt template or context file from a
  path.

### Output

With `--output <path>`, the run appends one JSON line with these fields:
`agent`, `engine_version`, `provider`, `model`, `reasoning_effort`, `budget`,
`budget_reached`, `input_digest`, `system_prompt_digest`, `workspace`,
`session`, `end`, `class`, `failure`, `duration_ms`, `model_calls`,
`tool_calls`, `usage`, `list_price_usd` and `text`.

- `end` is `completed`, `budget_end`, `stopped` or `failed`.
- `class` is `null` for `completed`, `retryable` for a failure that pi retries,
  and `terminal` for each other end.
- `failure` is the failure kind for the end `failed`, for example
  `bad_request`, `unauthorized` or `internal`. Else it is `null`.
- `budget` is `{ "wall_ms", "usd" }`, and `usd` is the cost budget or `null`.
- `input_digest` covers the prompt part texts, the context part texts, the
  model selection and the budget. It holds no path.
- `text` is the last assistant text. A known secret shows as the redaction
  marker.

The run refuses an output file with a wrong parent directory, owner, mode or
type with `cli.run.agent.output_invalid`. It refuses an output path inside the
workspace or the pi directory, and the `--auth` file or the session file, with
`cli.run.agent.output_place`. A refusal writes no line.

With `--output stdout`, stdout gets the text result: the line
`<agent> <end>`, one row per field, one empty line and the text.

### Classes

Each end has a class. The class decides the exit code for the end `failed`.

| Class       | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `retryable` | The same input can succeed later with a new `--session` path.          |
| `terminal`  | A change of the input, the credential or the environment is necessary. |

A later try also needs a workspace that passes the start preconditions.

- The end `completed` has no class (`null` in the result line).
- The end `failed` with a provider error is `retryable` when the error is not a
  context overflow and pi classifies it as retryable, for example a 429 rate
  limit. All other failures are `terminal`.
- `run agent` retries nothing by itself. pi retries a retryable error up to 3
  times inside the session, with a base delay of 2 seconds.
- The class applies to the error after the last pi retry.
- The wait of each pi retry counts against the wall budget. The first budget
  limit (wall or usd) that fires during a retry gives `budget_end` and exit `4`.

### Exit codes

| Exit | Cause                                                                     |
| ---- | ------------------------------------------------------------------------- |
| `0`  | The end `completed`.                                                      |
| `1`  | A refusal, a failed open (`cli.run.agent.open_failed`) or a syntax error. |
| `2`  | The end `stopped`: one SIGINT stops the turn.                             |
| `4`  | The end `budget_end`: the first budget limit (wall or usd) fired.         |
| `5`  | The end `failed` with a terminal failure.                                 |
| `75` | The end `failed` with a retryable failure.                                |

- A refusal writes no result.
- The end `failed` writes one diagnostic after the result:
  `cli.run.agent.provider_retryable`, `cli.run.agent.provider_failed` or
  `cli.run.agent.internal_error`, with the `reason` row.
- No stderr line holds a credential value.

# Plan 04: Worker unit — the usage of a stopped turn

## Scope

This plan writes the usage of a finished reply on a stopped turn for candidate C2 (decision D8, open item O3 option B).

Root cause: the tracer writes the usage attributes only at `turn_end` (`src/worker/unit/agent-telemetry.ts:337-356`). A pi turn ends after its tool calls. `messageEnded` (`:276-279`) keeps only the model duration. When `stop` ends the turn during a tool call, `endStopped` (`:220-225`) writes `error.type: stopped` with no usage (`:211-218`). The reply cost is then absent from the trace sum (root `docs/brainstorm/tracking-service.impl.md:204`). In trace `59701b512f40b83c28b6a1bb37779ad1`, the reply of 5470 tokens and $0.0089 reached only session entry 6.

The plan delivers:

- The usage of the last finished assistant reply of the open turn, kept at `message_end`.
- That usage on the `stopped` end of the turn.

Out of scope:

- A revocation or a loss. The gateway refuses each telemetry write after the end (`src/gateway/invocation.ts:116-128`). Root `docs/brainstorm/tracking-service.impl.md` states that limit with the line of decision D8, and Aelita opens that root pull request.
- Option D of the reviewer (open item O5).
- The trace summary and the cost analytics. They sum the span attributes as before.

## Model

Sonnet at high effort. The change is one class of the tracer and its test.

## Sources

- Root `docs/brainstorm/tracking-service.impl.md:33` — the usage attributes of `agent.turn`.
- Root `docs/brainstorm/tracking-service.impl.md:39` — a turn that the close of the agent trace ends holds `stopped`.
- Decision D8. Its root line: "A turn that the close of the agent trace ends also holds the usage attributes of its last finished reply."

## Depends on

- Start from `origin/main` of `kanthorlabs/kanthord-engine`. Plans 01, 02 and 03 touch no file of this plan.

## Tasks

### 04.1 Write the reproducing test

- Files: `src/worker/unit/telemetry.test.ts` (edit)
- Do:
  1. Add the test "a stop during a tool call ends the turn with stopped and the usage of its finished reply". Use `recorder`, `scriptedSession` and `traceAgent` as the test "the returned function ends the open tool and turn with Error and stopped, once" does (`:1109-1135`).
  2. Emit `turn_start`. Emit `message_end` with an assistant message that holds `stopReason: "toolUse"` and a usage of known values: `input`, `output`, `cacheRead`, `cacheWrite` and `cost.total`. Emit `tool_execution_start` for `bash`. Call the returned stop function.
  3. Assert the end of the `agent.tool` span with `error.type: stopped` and no usage attribute.
  4. Assert the end of the `agent.turn` span with status `Error`, `error.type: stopped`, `gen_ai.usage.input_tokens` equal to `input + cacheRead + cacheWrite`, `gen_ai.usage.output_tokens`, both cache attributes and `kanthord.usage.cost_usd`.
  5. Keep the test of `:1109`. A stop with no finished reply still writes `error.type: stopped` with no usage attribute.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/telemetry.test.ts` fails on the new test only.

### 04.2 Keep the usage and write it on the stopped turn

- Files: `src/worker/unit/agent-telemetry.ts` (edit)
- Do:
  1. Add the field `reply: AssistantMessage | null` to `AgentTracer`. `turnStarted` (`:241`) sets it to `null`.
  2. `messageEnded` (`:276-279`) sets `reply` to the assistant message of the event, beside the model duration.
  3. `stop` (`:211-218`) ends the open turn with `error.type: stopped` and, when `reply` is not null, the usage attributes of `turnAttributes(reply, this.assistantEntryId(), this.modelDurationMs)`. `error.type: stopped` replaces any `error.type` of the reply. Keep the status `Error`.
  4. `endStopped` keeps the tool end as today. Give it an optional attributes argument for the turn, or add a second method for the turn end. Choose the form that keeps one call for each span.
  5. `turnEnded` (`:337-356`) keeps its attributes of today and sets `reply` to `null`.
- Cite: decision D8.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/telemetry.test.ts src/worker/unit/agent-session.test.ts src/worker/unit/native-agent.test.ts` passes.

### 04.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the test of task 04.1 failed before task 04.2 and passes after it.
- The pull request body states that a revocation or a loss during a tool call still records no usage, and names the root pull request of decision D8.

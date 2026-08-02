# agent_invocation

**Question it answers:** what exactly did one model call receive, and what did it return?

```sql
CREATE TABLE agent_invocation (
  id                    TEXT PRIMARY KEY,
  attempt_id            TEXT NOT NULL REFERENCES attempt(id),                                   -- attempt this model call belongs to
  agent                 TEXT NOT NULL CHECK (agent IN ('general@1', 'swe@1', 'te@1', 're@1')),  -- role that ran; its tool set is defined in code
  adapter_version       TEXT NOT NULL,                                                          -- pi-coding-agent adapter version, needed to reproduce the call
  prompt_blob           TEXT NOT NULL REFERENCES blob(hash),                                    -- rendered messages exactly as sent
  sources_json          TEXT NOT NULL,                                                          -- channel to source blob hash and provenance label, for instructions resolve
  tool_definitions_blob TEXT NOT NULL REFERENCES blob(hash),                                    -- tool definitions offered to the model
  tool_trace_blob       TEXT REFERENCES blob(hash),                                             -- every tool call and its result
  diff_blob             TEXT REFERENCES blob(hash),                                             -- diff this call produced; null for a read-only role
  verdict               TEXT CHECK (verdict IS NULL OR verdict IN ('accept', 'reject')),        -- re@1 only: the review decision
  reason_blob           TEXT REFERENCES blob(hash),                                             -- re@1 only: a reason per acceptance criterion
  usage_json            TEXT,                                                                   -- token counts the provider reported
  error_blob            TEXT REFERENCES blob(hash),                                             -- provider or adapter failure detail
  ended_at              INTEGER                                                                 -- close time; the id is the start time
) STRICT;
```

One attempt of the `general@1` worker runs two agents: the `general@1` agent does the task, then `re@1` reviews the diff. Both are model calls with their own prompt, their own tool set and their own trace. One row per call keeps the attempt counter unambiguous and matches the attempt record the human reads.

The calls of one attempt are sequential, and the id orders them, so the table holds no sequence column.

`verdict` and `reason_blob` are set on an `re@1` row only. The reviewer verdict lives here, and not in `check_result`, because it is a model call with a provider, a model and a prompt. `check_result` records a command run. The two shapes share no columns worth merging.

`sources_json` maps each instruction channel to its blob hash and its provenance label. That is what `kanthord instructions resolve` prints, and it is what rebuilds a prompt after its source is gone. A hash of the rendered result alone cannot do either.

## Example

```
attempt_01JQ8ZH34C
  id                  invocation_01JQ8ZK78E     invocation_01JQ8ZL90F
  agent               general@1                 re@1
  prompt_blob         sha256:c81b...            sha256:03aa...
  tool_definitions    sha256:6c55...            sha256:4b8d...
  tool_trace_blob     sha256:b229...            sha256:e330...
  diff_blob           sha256:5e77...             (null)
  verdict              (null)                   reject
  reason_blob          (null)                   sha256:9c1e...
  usage_json          {in: 38201, out: 4110}    {in: 12904, out: 806}
```

One attempt of the `general@1` worker is two model calls. The implementer writes the diff, then `re@1` reviews it against the acceptance criteria and returns a reason per criterion.

The two prompts differ by design. `re@1` renders from a reduced prompt with no implementation guidance, so the review stays independent; a reviewer that read the same instruction as the implementer makes correlated mistakes. Different prompt, different tool set, different trace, so one row cannot hold both.

This is also why the split exists at all. With both calls in one table keyed by attempt number, three rows could mean three tries or one try with three calls. Here `MAX(attempt_no)` is unambiguous, and the attempt record the human reads from the CLI is one attempt with its invocations underneath.

### What `sources_json` carries

One entry per channel that reached the prompt, in the order it was rendered. `invocation_01JQ8ZK78E`, the `general@1` call:

```json
{
  "channels": [
    {
      "channel": "daemon-invariants",
      "blob": "sha256:04c7...",
      "bytes": 1806,
      "from": "code kanthord@27.8.1"
    },
    {
      "channel": "role-contract",
      "blob": "sha256:7fd1...",
      "bytes": 2411,
      "from": "code agent general@1"
    },
    {
      "channel": "repository-profile",
      "blob": "sha256:9f2a...",
      "bytes": 12431,
      "from": "profile_01JQ8Z6E1F pinned as workspace_01JQ8ZDV5W.profile_hash"
    },
    {
      "channel": "project-policy",
      "blob": "sha256:b8e0...",
      "bytes": 344,
      "from": "project_01JQ8Z5C9D"
    },
    {
      "channel": "task-contract",
      "blob": "sha256:e4d2...",
      "bytes": 2190,
      "from": "task_01JQ8ZBQ1R.instruction_blob"
    },
    {
      "channel": "ambient",
      "blob": "sha256:1d90...",
      "bytes": 903,
      "from": "AGENTS.md at 6d0b63f2, frozen as workspace_01JQ8ZDV5W.ambient_blob"
    },
    {
      "channel": "runtime-evidence",
      "blob": "sha256:9c1e...",
      "bytes": 1502,
      "from": "re@1 reasons of attempt_01JQ8ZH34C, and check_01JQ8ZN56J output"
    }
  ],
  "budget": { "limit": 60000, "used": 21587 },
  "dropped": []
}
```

`invocation_01JQ8ZL90F`, the `re@1` call on the same attempt, carries four channels and not seven:

```json
{
  "channels": [
    {
      "channel": "daemon-invariants",
      "blob": "sha256:04c7...",
      "bytes": 1806,
      "from": "code kanthord@27.8.1"
    },
    {
      "channel": "role-contract",
      "blob": "sha256:2ba9...",
      "bytes": 1974,
      "from": "code agent re@1, verdict format"
    },
    {
      "channel": "acceptance-criteria",
      "blob": "sha256:f107...",
      "bytes": 612,
      "from": "task_01JQ8ZBQ1R.acceptance_blob"
    },
    {
      "channel": "runtime-evidence",
      "blob": "sha256:5e77...",
      "bytes": 15044,
      "from": "diff of invocation_01JQ8ZK78E, and check_01JQ8ZN56J output"
    }
  ],
  "budget": { "limit": 60000, "used": 19436 },
  "dropped": []
}
```

Four properties of this document matter.

- **A channel absent from `channels` was not in the prompt.** The reviewer row has no `repository-profile`, no `project-policy` and no `task-contract` instruction body, which is the independence rule of [../phase-2/instructions-and-profiles.md](../phase-2/instructions-and-profiles.md) written as data. A reviewer that received implementation guidance is then a diff in this document rather than an argument.
- **`blob` resolves, so a prompt is rebuildable.** Every hash is a `blob.hash`, and a blob is never deleted while a row cites it. `kanthord instructions resolve` prints the composed prompt by reading these hashes, and each block names its origin.
- **`from` is provenance, not a path.** It names the row, the pin or the code version that produced the block, so a reader can tell a profile edit from a template change from a task edit.
- **`bytes` and `budget` explain a refusal.** Budget is enforced per channel and the failure is a refusal that names the channel, so the accounting has to be recorded rather than recomputed. `dropped` holds the ambient channel when the resolver dropped it, which is the only channel it may drop, and a drop also writes an event.

The order is the render order. It is not a precedence order: precedence is resolved before rendering, because a model does not reliably read later text as higher priority.

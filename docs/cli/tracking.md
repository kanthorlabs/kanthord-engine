# Tracking Service CLI specification

This page specifies the `kanthord tracking` command group and the Tracking
operations. Start with [the CLI specification index](./README.md) and
[shared CLI conventions](./other.md).

## Status and scope

**Implemented:** the Tracking Service owns `tracking.db`, a database file in the
data directory beside `kanthord.db`. It holds the tables of
[ERD 4](https://github.com/kanthorlabs/kanthord/blob/main/docs/reference/erd/04-tracking.md):
`tracking_trace`, `tracking_span`, `tracking_record`,
`tracking_telemetry_text` and `tracking_session_entry`. The server opens and migrates the file at start.

- The Scheduler Service opens the root span of an execution after the claim and
  ends it at the release or at the loss of the claim. A failed root write never
  fails the claim or the release. The Tracking Service counts the drop.
- A native worker writes its spans, telemetry texts and session entries with
  `tracking.telemetry.write` during its live execution. The operation is
  API-only.
- A human lists traces, reads a trace, its spans, its telemetry texts and its
  session entries, reads the timeline of an execution, a node or a project,
  reads the cost and duration analytics, and reads the filter values with the ten
  CLI leaves below.
- A human labels the cause of an ended trace with `cause label`. The label is
  an annotation that every reader of the cause prefers to the root cause.
- The server deletes a trace, with its spans, texts, records and session
  entries, `tracking.retention_days` after its creation. A sweep runs at the
  start and then every hour. A record of an older execution is `Refused` with
  `trace_expired`, and a server span of it is dropped and counted.

Telemetry is lossy and has no current effect. It is not Mission evidence,
assessment or outcome. It completes no node, renews no claim and authorizes no
operation. An absent span proves nothing, and a read never promises a complete
trace.

**Later work:** the capture of an external harness and the human-issued
`telemetry ingest` follow the root
[worker contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/explanation/worker-contract.md).
The ingestion reuses the record schema of `tracking.telemetry.write` and adds
`execution_id`.

## Command inventory and operation mapping

The literal service prefix is `/api/tracking`. Read requests have no body.

| Command suffix / synopsis                                                                                                                                                              | Operation identifier          | HTTP route                                                              | Access / effect                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `trace list [--project <project-id>] [--node <node-id>] [--state <state>] [--query <text>] [--sort <field>] [--from <unix-ms>] [--to <unix-ms>] [--limit <count>] [--cursor <opaque>]` | `tracking.trace.list`         | `GET /api/tracking/trace`                                               | `human`; read                               |
| `timeline list (--execution <execution-id> \| --node <node-id> \| --project <project-id>) [--depth <1\|2>] [--from <unix-ms>] [--to <unix-ms>] [--limit <count>] [--cursor <opaque>]`  | `tracking.timeline.list`      | `GET /api/tracking/timeline`                                            | `human`; read                               |
| `analytics cost [--group-by <field>] [--bucket <size>] [--project <project-id>] [--node <node-id>] [--from <unix-ms>] [--to <unix-ms>]`                                                | `tracking.analytics.cost`     | `GET /api/tracking/analytics/cost`                                      | `human`; read                               |
| `analytics duration --measure <measure> [--operation <name>] [--group-by <field>] [--bucket <size>] [--project <project-id>] [--node <node-id>] [--from <unix-ms>] [--to <unix-ms>]`   | `tracking.analytics.duration` | `GET /api/tracking/analytics/duration`                                  | `human`; read                               |
| `facet get [--project <project-id>]`                                                                                                                                                   | `tracking.facet.get`          | `GET /api/tracking/facet`                                               | `human`; read                               |
| `trace get <trace-id>`                                                                                                                                                                 | `tracking.trace.get`          | `GET /api/tracking/trace/:trace_id`                                     | `human`; read                               |
| `span list <trace-id> [--limit <count>] [--cursor <opaque>]`                                                                                                                           | `tracking.span.list`          | `GET /api/tracking/trace/:trace_id/span`                                | `human`; read                               |
| `session entry list <trace-id> <session-id> [--tool-call <tool-call-id>] [--limit <count>] [--cursor <opaque>]`                                                                        | `tracking.session.entry.list` | `GET /api/tracking/trace/:trace_id/session/:session_id/entry`           | `human`; read                               |
| `session entry get <trace-id> <session-id> <entry-id>`                                                                                                                                 | `tracking.session.entry.get`  | `GET /api/tracking/trace/:trace_id/session/:session_id/entry/:entry_id` | `human`; read                               |
| `text get <trace-id> <text-id>`                                                                                                                                                        | `tracking.text.get`           | `GET /api/tracking/trace/:trace_id/text/:text_id`                       | `human`; read                               |
| `cause label <trace-id> --category <category> --subcategory <subcategory> --reason <text> [--idempotency-key <key>]`                                                                   | `tracking.cause.label`        | `POST /api/tracking/trace/:trace_id/cause/label`                        | `human`; mutation, idempotency key required |

API-only operation:

| Operation identifier       | HTTP route                                             | Access / effect                                                       |
| -------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `tracking.telemetry.write` | `POST /api/tracking/execution/:execution_id/telemetry` | `client` with the execution proof; mutation, idempotency key required |

## Synopses

```text
kanthord tracking [--help]

kanthord tracking trace list [--project <project-id>] [--node <node-id>]
  [--state <state>] [--cause-category <category>] [--query <text>]
  [--sort <field>] [--from <unix-ms>] [--to <unix-ms>] [--limit <count>]
  [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking timeline list
  (--execution <execution-id> | --node <node-id> | --project <project-id>)
  [--depth <1|2>] [--from <unix-ms>] [--to <unix-ms>] [--limit <count>]
  [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking analytics cost [--group-by <field>] [--bucket <size>]
  [--project <project-id>] [--node <node-id>] [--from <unix-ms>]
  [--to <unix-ms>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking analytics duration --measure <measure> [--operation <name>]
  [--group-by <field>] [--bucket <size>] [--project <project-id>]
  [--node <node-id>] [--from <unix-ms>] [--to <unix-ms>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking facet get [--project <project-id>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking trace get <trace-id>
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking span list <trace-id> [--limit <count>] [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking text get <trace-id> <text-id>
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking cause label <trace-id> --category <category>
  --subcategory <subcategory> --reason <text> [--idempotency-key <key>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking session entry list <trace-id> <session-id>
  [--tool-call <tool-call-id>] [--limit <count>] [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking session entry get <trace-id> <session-id> <entry-id>
  [--endpoint <url>] [--token <jwt>] [--help]
```

Each leaf and group supports `--help` without a server or credential. A leaf
rejects unknown arguments and options before work.

### Identity and timestamp validation

- `TraceID` is 32 and `SpanID` is 16 lower-case hexadecimal characters, never
  all zero. The Scheduler mints both at the claim.
- `RecordID` and `TextID` have the form `<span_id>:<name>`. The name starts with
  a lower-case letter and holds lower-case letters, digits, `_`, `.` and `-`. The
  whole value is at most 128 characters. A span record uses
  `<span_id>:start` and `<span_id>:end`. A text uses
  `<span_id>:<text name>`, and its record identity equals its text identity. A session entry record uses
  `<session_id>:entry.<entry_id>`. The one text identity outside this format is
  `<root_span_id>.cause_label:reason`. See [`text get`](#text-get).
- `EntryID` is 1 to 64 lower-case letters, digits and `-`. It starts with a
  letter or a digit.
- `Timestamp` is a JSON integer of Unix milliseconds in UTC.
- `AttributeValue` is a string, a boolean, a safe integer, a finite number, or
  an array of at most 128 values of one primitive kind. Attribute names reuse
  the OpenTelemetry conventions. Kanthord identity attributes use the
  `kanthord.` prefix.

## `trace list`

Reads one page of trace summaries, newest first by default. Each item is a
trace summary of [`trace get`](#trace-get) with three more fields:
`root_operation`, `root_attributes` and `cause`. The first two hold the
`operation` and the `attributes` of the root span. Both are `null` while the
store holds no root span. `root_attributes` of an execution trace holds
`kanthord.node.name`, the node name of the revision at the claim. `cause` is the effective cause of the trace as
`{ category, subcategory, assigner, suspects }`, or `null` when the trace has no
cause. The cause of the cause label span wins when the store holds one, and its
assigner is `human`. Otherwise `cause` is the cause that the root span end
holds. `next_cursor` is `null` on the last page.

The API filters of `tracking.trace.list` combine with AND:

| Query field        | Meaning                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`       | The trace has this project.                                                                                                                             |
| `node_id`          | The trace has this node.                                                                                                                                |
| `execution_id`     | The trace has this execution.                                                                                                                           |
| `worker_name`      | The trace has this worker name.                                                                                                                         |
| `agent_name`       | The trace has this value in `agent_names`.                                                                                                              |
| `model`            | The trace has this value in `models`.                                                                                                                   |
| `error_type`       | The trace has this value in `error_types`.                                                                                                              |
| `state`            | The trace has this state: `open`, `ok` or `error`.                                                                                                      |
| `cause_category`   | The effective cause of the trace has this category. The label span wins over the root span.                                                             |
| `q`                | A case-insensitive text of 1 to 200 characters. It matches a part of the trace ID, execution, node, worker, stop reason, agents, models or error types. |
| `from`             | The trace ends at or after this `Timestamp`, or has no `ended_at`.                                                                                      |
| `to`               | The trace starts at or before this `Timestamp`. The start is `started_at`, else `created_at`.                                                           |
| `min_duration_ms`  | The duration is at least this integer. A trace without a duration fails a duration bound.                                                               |
| `max_duration_ms`  | The duration is at most this integer.                                                                                                                   |
| `min_total_tokens` | `total_tokens` is at least this integer.                                                                                                                |
| `max_total_tokens` | `total_tokens` is at most this integer.                                                                                                                 |
| `min_cost_usd`     | `cost_usd` is at least this number.                                                                                                                     |
| `max_cost_usd`     | `cost_usd` is at most this number.                                                                                                                      |

`from` and `to` select by window overlap: the window of a trace runs from its
start to its `ended_at`, and stays open with no `ended_at`. A missing bound
leaves that side open. A `from` after `to` answers `400`
`tracking.filter.range_invalid`.

The CLI exposes `--project`, `--node`, `--state`, `--cause-category`, `--query`,
`--sort`, `--from` and `--to`. `--cause-category` sets `cause_category`. An
invalid category exits 1 with `cli.tracking.trace.list.invalid_cause_category`.
`--query` sets `q` and has 1 to 200 characters. `--from` and `--to`
set `from` and `to` and take Unix milliseconds. An invalid value exits 1 with
`cli.tracking.trace.list.invalid_query`. The other filters are API-only query
fields.

`--sort` is one of `started_at` (the default), `duration_ms`, `total_tokens` and
`cost_usd`. The order is the sort value in descending order, then the creation
order of the trace in descending order. A trace without a start sorts by its
creation time. An open trace sorts last under `duration_ms`.

`--limit` is 1 to 1000 and defaults to 100. The cursor names its sort. A cursor
of another sort answers `400` `system.pagination.cursor_invalid`.

## `timeline list`

Reads one page of the timeline of one scope: the root span of each selected
trace and, at depth 2, the spans below that root span. The query holds exactly
one scope, `execution_id`, `node_id` or `project_id`. Another count of scopes
answers `400` `gateway.request.validation_failed`. The scope selects every trace
whose row names that execution, that node or that project.

| Query field    | Meaning                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `execution_id` | Scope: the traces of this execution.                                                                                                |
| `node_id`      | Scope: the traces of this node.                                                                                                     |
| `project_id`   | Scope: the traces of this project.                                                                                                  |
| `from`         | The trace ends at or after this `Timestamp`, or has no `ended_at`. A missing bound leaves the side open.                            |
| `to`           | The trace starts at or before this `Timestamp`. The start is `started_at`, else `created_at`.                                       |
| `depth`        | `1` or `2`, default `2`. Depth 1 answers the root span of each trace. Depth 2 also answers each span whose parent is the root span. |
| `limit`        | 1 to 1000, default 500.                                                                                                             |
| `cursor`       | The `next_cursor` of the previous page.                                                                                             |

A `from` after `to` answers `400` `tracking.filter.range_invalid`.

Depth 2 answers a span of the root span also when the store holds no row of the
root span. The timeline holds depths 1 and 2 only. `span list` of one trace
answers the deeper spans.

The order is ascending by the start of the trace, then by `trace_id`. Inside one
trace, the order is ascending by the timeline time of the span, then by
`span_id`. The timeline time of a span is its `start_time`, else its `end_time`.

Each item holds the fields of a span of [`span list`](#span-list) and these
fields: `depth`, `duration_ms`, `project_id`, `node_id`, `execution_id` and
`attempt`. `duration_ms` is `end_time - start_time`, or `null` when the span
holds no start or no end. The last four fields come from the trace row. An item
of depth 1 also holds `worker_name` of the trace row, and an item of depth 2
holds `worker_name: null`.

The read keeps at most `limit + 1` traces whose end comes after the cursor and
adds one end row for each kept trace, after the items of that trace.

- With more than `limit` items, the page holds the first `limit` items, and
  `next_cursor` names the last item of the page.
- With at most `limit` items and more than `limit` end rows, the page holds every
  item, and `next_cursor` names the last end row.
- Otherwise the page holds every item, and `next_cursor` is `null`.

A page can hold fewer than `limit` items, or no item, and still hold a
`next_cursor`. A cursor of another form answers `400`
`system.pagination.cursor_invalid`.

The CLI takes exactly one of `--execution`, `--node` and `--project`. `--depth`
takes `1` or `2`. `--from` and `--to` set `from` and `to` and take Unix
milliseconds. `--limit` is 1 to 1000. A missing scope or two scopes exit 1 with
`cli.tracking.timeline.list.invalid_query`.

## `analytics cost`

Sums the tokens and the cost of the `agent.turn` spans that start in a range. The
read selects the traces that overlap the range, as `trace list` does, and reads
their spans in steps of 100 traces. It never writes. `from` and `to` are
`Timestamp` values.

| Query field  | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `project_id` | The trace has this project.                                          |
| `node_id`    | The trace has this node.                                             |
| `from`       | The start of the range. Default: 7 days before `to`.                 |
| `to`         | The end of the range. Default: the time of the read.                 |
| `group_by`   | The group of an item. Default `model`. See the closed set below.     |
| `bucket`     | The time bucket of an item. Default `day`. See the closed set below. |

The range holds at most 31 days. A range of more than 31 days, or a `from` after
`to`, answers `400` `tracking.filter.range_invalid`. The check uses the
default of a missing bound.

`group_by` is one of `none`, `model`, `agent_name`, `provider_name`,
`worker_name`, `node_id` and `project_id`. The key `model` is
`gen_ai.response.model`, else `gen_ai.request.model`. The keys `agent_name` and
`provider_name` come from `kanthord.agent.name` and `gen_ai.provider.name`. The
keys `worker_name`, `node_id` and `project_id` come from the trace row. `none`
gives the key `null`. A span without the value has the key `null`.

`bucket` is one of `none`, `hour`, `day` and `week`. A bucket starts at a UTC
hour, a UTC day or a UTC Monday. `none` gives `bucket_start: null`.

The answer holds `items` and `truncated`. Each item holds `key`, `bucket_start`,
`turn_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `total_tokens` and `cost_usd`. A missing attribute counts
as 0. The order is ascending by `bucket_start`, then descending by `cost_usd`,
then ascending by `key` with `null` last. The answer holds at most 1000 items.
`truncated` is `true` when more items exist.

The CLI exposes `--group-by`, `--bucket`, `--project`, `--node`, `--from` and
`--to`. An invalid `--group-by`, `--bucket`, `--from` or `--to` exits 1 with
`cli.tracking.analytics.cost.invalid_query`. `--from` and `--to` take Unix
milliseconds.

## `analytics duration`

Summarizes one measure of the spans that start in a range as percentiles, mean
and maximum. The range, the filters, the trace selection, the step size and the
bucket rules are those of [`analytics cost`](#analytics-cost).

| Query field                           | Meaning                                                              |
| ------------------------------------- | -------------------------------------------------------------------- |
| `measure`                             | Required. The measure. See the closed set below.                     |
| `operation`                           | The span operation of the measure `span_duration`. Others ignore it. |
| `group_by`                            | The group of an item. Default `none`. See the closed set below.      |
| `bucket`                              | The time bucket of an item. Default `none`.                          |
| `project_id`, `node_id`, `from`, `to` | As in `analytics cost`.                                              |

`measure` is one of:

| Measure               | Value of one sample                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `span_duration`       | `end_time - start_time` of a span, all spans or the spans of `operation`. A span without both times is skipped.      |
| `tool_latency`        | The same for the `agent.tool` spans.                                                                                 |
| `verification_time`   | The same for the `worker.verification` spans.                                                                        |
| `queue_wait`          | `kanthord.queue.wait_ms` of the root span of an execution of the kind `steps`.                                       |
| `review_wait`         | `kanthord.queue.wait_ms` of the root span of an execution of the kind `evaluation`.                                  |
| `revision_turns`      | The count of transitions from `Evaluating` to `Available` of one node attempt.                                       |
| `instance_busy_ratio` | The sum of `duration_ms` of the root spans of one `kanthord.worker.instance`, divided by the range or bucket length. |

`group_by` is one of `none`, `operation`, `tool_name`, `agent_name`, `model`,
`worker_name`, `worker_instance`, `node_id` and `project_id`. The key
`tool_name` is `gen_ai.tool.name`. The key `worker_instance` is
`kanthord.worker.instance` of the span. The key of `worker_instance` is the
instance name for a worker instance. It is `<binding name>/<slot name>` for a
slot of the `server` or the `container` placement, for example
`coder/server slot 0`. The other keys follow `analytics cost`.
The measure `instance_busy_ratio` takes the `group_by` `worker_instance` only,
and `worker_instance` takes that measure only. Another pairing answers `400`
`gateway.request.validation_failed`.

The measure `instance_busy_ratio` reads the root spans that start in the range.
It skips a root span with no `end_time` or with no string
`kanthord.worker.instance`, so an open root span adds nothing. A root span adds
`min(end_time, limit) - start_time` to its instance and bucket. The `limit` is
the end of its bucket, or `to` with no `bucket`. The `ratio` of an item is its
sum divided by the length of its bucket, or by `to - from` with no `bucket`.
The `ratio` is `0` when that length is `0`.

The answer holds `items` and `truncated`. Each item holds `key`, `bucket_start`,
`count`, `p50`, `p90`, `p99`, `mean` and `max`. An item of `instance_busy_ratio`
holds `key` (the instance name), `bucket_start`, `count` (the root spans) and
`ratio`, and no percentile. A percentile interpolates
linearly between the two nearest samples. The order is ascending by
`bucket_start`, then descending by `count`, then ascending by `key` with `null`
last. The answer holds at most 1000 items.

The CLI exposes `--measure`, `--operation`, `--group-by`, `--bucket`, `--project`,
`--node`, `--from` and `--to`. A missing `--measure`, or an invalid `--measure`,
`--group-by`, `--bucket`, `--from` or `--to`, exits 1 with
`cli.tracking.analytics.duration.invalid_query`. A pair of `--measure` and
`--group-by` that the pairing rule refuses exits 1 with the same code.

## `facet get`

Reads the distinct values that a filter form offers. The answer holds the five
arrays `worker_names`, `agent_names`, `models`, `error_types` and
`cause_categories`. `cause_categories` holds the categories of the effective
causes of the traces. Each array holds at most 200 values in ascending order. `--project` limits the values to
the traces of one project.

## `trace get`

Reads the summary of one trace. The summary holds the state and the times of
the root span and the totals of the stored spans. Each admitted span updates it
in the same transaction. An unknown trace answers `404`
`tracking.trace.not_found`.

### Trace summary fields

| Field                   | Type                            | Meaning                                                                                                              |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `trace_id`              | `TraceID`                       | The identity of the trace.                                                                                           |
| `project_id`            | `ProjectID` or `null`           | The project of the execution.                                                                                        |
| `execution_id`          | `ExecutionID` or `null`         | The execution of the trace.                                                                                          |
| `node_id`               | `NodeID` or `null`              | The node of the execution.                                                                                           |
| `attempt`               | Integer of 1 or more, or `null` | The attempt of the node.                                                                                             |
| `root_span_id`          | `SpanID`                        | The root span of the trace.                                                                                          |
| `created_at`            | `Timestamp`                     | The time that Tracking stored the trace.                                                                             |
| `state`                 | `open`, `ok`, `error`           | `open` while the root span has no end. Then `error` for the root status `Error`, otherwise `ok`.                     |
| `started_at`            | `Timestamp` or `null`           | The start of the root span.                                                                                          |
| `ended_at`              | `Timestamp` or `null`           | The end of the root span.                                                                                            |
| `duration_ms`           | Integer of 0 or more, or `null` | `ended_at - started_at` when both exist, otherwise `null`.                                                           |
| `stop_reason`           | String or `null`                | The value of `kanthord.stop.reason` of the root span.                                                                |
| `worker_name`           | String or `null`                | The first value of `kanthord.worker.name` of a stored span.                                                          |
| `agent_names`           | Array of strings                | The distinct values of `kanthord.agent.name`, in order of first admission. At most 128.                              |
| `models`                | Array of strings                | The distinct values of `gen_ai.request.model` and `gen_ai.response.model`, in order of first admission. At most 128. |
| `error_types`           | Array of strings                | The distinct values of `error.type`, in order of first admission. At most 128.                                       |
| `input_tokens`          | Integer of 0 or more            | The sum of `gen_ai.usage.input_tokens` of the spans.                                                                 |
| `output_tokens`         | Integer of 0 or more            | The sum of `gen_ai.usage.output_tokens` of the spans.                                                                |
| `cache_read_tokens`     | Integer of 0 or more            | The sum of `gen_ai.usage.cache_read.input_tokens` of the spans.                                                      |
| `cache_creation_tokens` | Integer of 0 or more            | The sum of `gen_ai.usage.cache_creation.input_tokens` of the spans.                                                  |
| `total_tokens`          | Integer of 0 or more            | `input_tokens + output_tokens`.                                                                                      |
| `cost_usd`              | Finite number of 0 or more      | The sum of `kanthord.usage.cost_usd` of the spans, in US dollars.                                                    |
| `span_count`            | Integer of 0 or more            | The number of stored spans.                                                                                          |
| `turn_count`            | Integer of 0 or more            | The number of stored `agent.turn` spans.                                                                             |
| `tool_count`            | Integer of 0 or more            | The number of stored `agent.tool` spans.                                                                             |
| `error_count`           | Integer of 0 or more            | The number of stored spans with the status `Error`.                                                                  |
| `first_error_span_id`   | `SpanID` or `null`              | The first stored span below the root with the status `Error` and no `error.type` `tool_error` or `stopped`.          |

The summary counts the stored spans only, so it is as lossy as the spans. The
field `cost_usd` is an estimate that pi computes from its model price table.

## `span list`

Reads one page of the stored spans of a trace, oldest first. `--limit` is 1 to
1000 and defaults to 500. `next_cursor` is `null` on the last page. Each span
holds `trace_id`, `span_id`, `parent_span_id`, `producer`, `origin`,
`operation`, `start_time`, `end_time`, `status`, `attributes`, `events`,
`links`, `text_ids` and `created_at`. The cause label span of a trace has the
span identity `<root_span_id>.cause_label`, the one identity outside the
`SpanID` format. A span with a start and no end is an operation that still runs. The parent of a span can be absent from the page or
from the store.

## `text get`

Reads one telemetry text. The answer holds `trace_id`, `text_id`, `content` and
`created_at`. The reason text of a cause label has the text identity
`<root_span_id>.cause_label:reason`, the one text identity outside the `TextID`
format. A telemetry text has no state of its own. It expires with its
trace: one delete of the trace row removes its spans, texts and records. A
trace expires `tracking.retention_days` after its creation. An
unknown text answers `404` `tracking.text.not_found`. An unknown or deleted
trace answers `404` `tracking.trace.not_found`.

## `cause label`

Writes the human label of the cause of one trace, or replaces it. A rule often
leaves the cause `unattributed` with suspects. A human reads the trace and names
the cause. The operation is a mutation and requires an idempotency key. The CLI
generates the key when `--idempotency-key` is absent, and prints it.

The body is `{ category, subcategory, reason }`:

| Body field    | Type                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `category`    | A cause category except `unattributed`.                                                     |
| `subcategory` | A cause subcategory of the category.                                                        |
| `reason`      | A nonblank text of 1 to 4096 characters after trimming. The stored text is the trimmed one. |

A `category` outside the set, a blank `reason` or an unknown field answers `400`
`gateway.request.validation_failed`. A `subcategory` outside the set of its
category answers `400` `tracking.cause.subcategory_mismatch` with the details
`{ category, subcategory }`. An unknown or deleted trace answers `404`
`tracking.trace.not_found`. A trace whose state is `open` answers `409`
`tracking.cause.trace_open`.

The answer holds `trace_id`, `span_id`, `cause`, `reason` and `created_at`.
`span_id` is `<root_span_id>.cause_label`. `cause` is the label cause as
`{ category, subcategory, assigner }` with the assigner `human`. `reason` is
the stored text. `created_at` is the time of the write.

The label rules:

- One transaction writes the span `tracking.cause_label` under the root span and
  its telemetry text `reason`. The span has the span identity
  `<root_span_id>.cause_label`, the producer `tracking`, the origin `asserted`
  and the status `Ok`. Its `start_time` and `end_time` are the time of the
  write.
- The span holds the attributes `kanthord.cause.category`,
  `kanthord.cause.subcategory` and `kanthord.human.username`. The last one is
  the `sub` of the `human` token. The text has the text identity
  `<root_span_id>.cause_label:reason`, and `text get` reads it.
- A new label replaces the old attributes and the old text in the same
  transaction. A trace holds one label span. The label span is the only span
  that the store replaces.
- The write bypasses the admission of the server spans. It writes no record and
  changes no column of the trace row, so the trace summary stays the same.
- `trace list`, `facet get` and `span list` answer the label. The label cause
  wins over the root cause.
- A cause label is a human annotation of a trace. It is no assessment, it has
  no current effect, and no service reads it to decide.

The CLI takes the required options `--category`, `--subcategory` and `--reason`.
A malformed `<trace-id>` exits 1 with `cli.tracking.cause.label.invalid_trace_id`.
An invalid body exits 1 with `cli.tracking.cause.label.invalid_input`. A missing
token exits 1 with `cli.tracking.cause.label.token_required`. A lost answer
exits 1 with `cli.tracking.cause.label.indeterminate`. Repeat the command with
the printed idempotency key.

## `session entry list`

Reads one page of the stored entries of one agent session, in ascending order of
`sequence`. The session identity is the span identity of the `agent.session`
span. `--limit` is 1 to 1000 and defaults to 100. `next_cursor` is `null` on
the last page. `--tool-call` keeps the entries with this tool call identity,
for example the tool result of a tool call. The page promises no complete
session: an entry can be absent. A session that the trace does not hold answers
an empty page. An unknown or deleted trace answers `404`
`tracking.trace.not_found`.

Each entry holds the eleven fields `trace_id`, `session_id`, `entry_id`,
`parent_entry_id`, `sequence`, `entry_type`, `entry_time`, `tool_call_id`,
`truncated`, `entry` and `created_at`. The value `truncated: true` marks an entry
whose strings the producer cut.

## `session entry get`

Reads one entry of an agent session. The answer holds the eleven fields of
[`session entry list`](#session-entry-list). An unknown entry answers `404`
`tracking.entry.not_found`. An unknown or deleted trace answers `404`
`tracking.trace.not_found`.

## `tracking.telemetry.write`

A native worker writes the records of its live execution. The gateway proves
that the execution is a live claim of the caller's registration. The Tracking
Service derives the producer from the claimant runtime identity and stores each
span with the origin `observed`.

The body is `{ "records": [...] }` with 1 to 1000 records and at most 1 MiB. The
answer is the acknowledgement below.

### Span record fields (`kind: "span"`)

| Field            | Requiredness and type                                       | Meaning                                                                                  |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `record_id`      | Required `RecordID`                                         | Producer-minted identity. A repeat of a stored identity is `Stored` and changes nothing. |
| `trace_id`       | Required `TraceID`                                          | The trace of the proven execution. Another trace is refused.                             |
| `kind`           | Required `"span"`                                           | Selects the span variant.                                                                |
| `span_id`        | Required `SpanID`                                           | The span that the record creates or extends.                                             |
| `operation`      | Required string, 1 to 256 bytes                             | The operation name. A later record cannot change it.                                     |
| `parent_span_id` | Required `SpanID`                                           | The root span or a span below it. A span cannot name itself.                             |
| `start_time`     | Optional `Timestamp`                                        | At least one of `start_time` and `end_time` is present.                                  |
| `end_time`       | Optional `Timestamp`                                        | A second end is refused.                                                                 |
| `status`         | Optional `Unset`, `Ok`, `Error`                             | A set status other than `Unset` cannot change.                                           |
| `attributes`     | Optional attribute map, at most 128 names                   | A later record adds names and cannot change a set value.                                 |
| `events`         | Optional array of at most 128 `{ name, time, attributes? }` | Appended.                                                                                |
| `links`          | Optional array of at most 128 `{ trace_id, span_id }`       | Appended.                                                                                |
| `text_ids`       | Optional array of at most 128 `TextID`                      | Added once each. A text is never embedded in a span.                                     |

### Text record fields (`kind: "text"`)

| Field       | Requiredness and type       | Meaning                                                           |
| ----------- | --------------------------- | ----------------------------------------------------------------- |
| `record_id` | Required `RecordID`         | Equals `text_id`.                                                 |
| `trace_id`  | Required `TraceID`          | The trace of the proven execution.                                |
| `kind`      | Required `"text"`           | Selects the text variant.                                         |
| `text_id`   | Required `TextID`           | A text keeps its first content. Another record for it is refused. |
| `text`      | Required well-formed string | The encoded record is at most 64 KiB.                             |

### Session entry record fields (`kind: "session_entry"`)

| Field             | Requiredness and type                      | Meaning                                                                            |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `record_id`       | Required `RecordID`                        | Equals `<session_id>:entry.<entry_id>`.                                            |
| `trace_id`        | Required `TraceID`                         | The trace of the proven execution.                                                 |
| `kind`            | Required `"session_entry"`                 | Selects the session entry variant.                                                 |
| `session_id`      | Required `SpanID`                          | The span identity of the `agent.session` span of the session.                      |
| `entry_id`        | Required string of 1 to 64 `[0-9a-z-]`     | The identity of the entry. It starts with a digit or a letter.                     |
| `parent_entry_id` | Required `entry_id` or `null`              | The parent entry of the entry.                                                     |
| `sequence`        | Required safe integer of 1 or more         | The position of the entry in its session. A second entry at a sequence is refused. |
| `entry_type`      | Required string, 1 to 256 bytes            | The type of the entry, for example `message`.                                      |
| `entry_time`      | Required `Timestamp`                       | The time of the entry.                                                             |
| `tool_call_id`    | Required string, 1 to 256 bytes, or `null` | The tool call identity of a tool result entry.                                     |
| `truncated`       | Required boolean                           | Whether the producer cut the entry.                                                |
| `entry`           | Required JSON object                       | The entry. The encoded record is at most 64 KiB.                                   |

### Output and failure conventions

The acknowledgement holds one disposition for each submitted record, in order,
and the counts `submitted`, `stored` and `refused`. A disposition is `Stored`
after the commit, or `Refused` with a reason. A refusal is structural and
permanent: retry the record only with a new identity and new content.

| Refusal reason     | Condition                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace_mismatch`   | The record names a trace other than the trace of the execution.                                                                                                  |
| `execution_bound`  | The trace already holds 50,000 records.                                                                                                                          |
| `record_too_large` | The canonical JSON of the record is larger than 64 KiB.                                                                                                          |
| `self_parent`      | The span names itself as its parent.                                                                                                                             |
| `foreign_producer` | Another producer created the span.                                                                                                                               |
| `value_replaced`   | The record changes the operation, the parent, a time, a status or an attribute value of the span, or a new session entry takes a stored sequence of its session. |
| `text_exists`      | The text already holds content.                                                                                                                                  |
| `trace_expired`    | The execution is older than the retention of the server.                                                                                                         |

One transaction applies the whole batch. A transport failure or a timeout
leaves every disposition unknown, and the producer retries the same records
with the same identities.

## Error codes

Every remote command can also answer the shared codes of
[other.md](other.md#error-codes).

| HTTP  | Code                                                 | Condition                                                                                                                                                            | Commands                                                 |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| local | `cli.tracking.trace.list.invalid_project_id`         | `--project` is not a `ProjectID`.                                                                                                                                    | trace list                                               |
| local | `cli.tracking.trace.list.invalid_node_id`            | `--node` is not a `NodeID`.                                                                                                                                          | trace list                                               |
| local | `cli.tracking.trace.list.invalid_state`              | `--state` is not `open`, `ok` or `error`.                                                                                                                            | trace list                                               |
| local | `cli.tracking.trace.list.invalid_cause_category`     | `--cause-category` is not a cause category.                                                                                                                          | trace list                                               |
| local | `cli.tracking.trace.list.invalid_sort`               | `--sort` is not a sort field.                                                                                                                                        | trace list                                               |
| local | `cli.tracking.trace.list.invalid_query`              | `--query` is empty or has more than 200 characters, or `--from` or `--to` is not Unix milliseconds.                                                                  | trace list                                               |
| local | `cli.tracking.timeline.list.invalid_query`           | `--execution`, `--node` and `--project` do not hold exactly one scope, or `--from` or `--to` is not Unix milliseconds.                                               | timeline list                                            |
| local | `cli.tracking.timeline.list.invalid_execution_id`    | `--execution` is not an `ExecutionID`.                                                                                                                               | timeline list                                            |
| local | `cli.tracking.timeline.list.invalid_node_id`         | `--node` is not a `NodeID`.                                                                                                                                          | timeline list                                            |
| local | `cli.tracking.timeline.list.invalid_project_id`      | `--project` is not a `ProjectID`.                                                                                                                                    | timeline list                                            |
| local | `cli.tracking.timeline.list.invalid_depth`           | `--depth` is not `1` or `2`.                                                                                                                                         | timeline list                                            |
| local | `cli.tracking.timeline.list.token_required`          | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | timeline list                                            |
| local | `cli.tracking.timeline.list.indeterminate`           | The answer is lost. Repeat the read.                                                                                                                                 | timeline list                                            |
| local | `cli.tracking.facet.get.invalid_project_id`          | `--project` is not a `ProjectID`.                                                                                                                                    | facet get                                                |
| local | `cli.tracking.trace.list.token_required`             | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | trace list                                               |
| local | `cli.tracking.facet.get.token_required`              | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | facet get                                                |
| local | `cli.tracking.trace.list.indeterminate`              | The answer is lost. Repeat the read.                                                                                                                                 | trace list                                               |
| local | `cli.tracking.facet.get.indeterminate`               | The answer is lost. Repeat the read.                                                                                                                                 | facet get                                                |
| local | `cli.tracking.trace.get.invalid_trace_id`            | The `<trace-id>` argument is not a `TraceID`.                                                                                                                        | trace get                                                |
| local | `cli.tracking.span.list.invalid_trace_id`            | The `<trace-id>` argument is not a `TraceID`.                                                                                                                        | span list                                                |
| local | `cli.tracking.text.get.invalid_trace_id`             | The `<trace-id>` argument is not a `TraceID`.                                                                                                                        | text get                                                 |
| local | `cli.tracking.text.get.invalid_text_id`              | The `<text-id>` argument is not a `TextID` or a cause label reason text identity.                                                                                    | text get                                                 |
| local | `cli.tracking.trace.get.token_required`              | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | trace get                                                |
| local | `cli.tracking.span.list.token_required`              | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | span list                                                |
| local | `cli.tracking.text.get.token_required`               | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | text get                                                 |
| local | `cli.tracking.trace.get.indeterminate`               | The answer is lost. Repeat the read.                                                                                                                                 | trace get                                                |
| local | `cli.tracking.span.list.indeterminate`               | The answer is lost. Repeat the read.                                                                                                                                 | span list                                                |
| local | `cli.tracking.text.get.indeterminate`                | The answer is lost. Repeat the read.                                                                                                                                 | text get                                                 |
| local | `cli.tracking.cause.label.invalid_trace_id`          | The `<trace-id>` argument is not a `TraceID`.                                                                                                                        | cause label                                              |
| local | `cli.tracking.cause.label.invalid_input`             | `--category` is not a cause category other than `unattributed`, `--subcategory` is not a cause subcategory, or `--reason` is blank or has more than 4096 characters. | cause label                                              |
| local | `cli.tracking.cause.label.token_required`            | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | cause label                                              |
| local | `cli.tracking.cause.label.indeterminate`             | The answer is lost. Repeat the command with the same idempotency key.                                                                                                | cause label                                              |
| local | `cli.tracking.session.entry.list.invalid_trace_id`   | The `<trace-id>` argument is not a `TraceID`.                                                                                                                        | session entry list                                       |
| local | `cli.tracking.session.entry.list.invalid_session_id` | The `<session-id>` argument is not a `SpanID`.                                                                                                                       | session entry list                                       |
| local | `cli.tracking.session.entry.list.token_required`     | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | session entry list                                       |
| local | `cli.tracking.session.entry.list.indeterminate`      | The answer is lost. Repeat the read.                                                                                                                                 | session entry list                                       |
| local | `cli.tracking.session.entry.get.invalid_trace_id`    | The `<trace-id>` argument is not a `TraceID`.                                                                                                                        | session entry get                                        |
| local | `cli.tracking.session.entry.get.invalid_session_id`  | The `<session-id>` argument is not a `SpanID`.                                                                                                                       | session entry get                                        |
| local | `cli.tracking.session.entry.get.invalid_entry_id`    | The `<entry-id>` argument is not an `EntryID`.                                                                                                                       | session entry get                                        |
| local | `cli.tracking.session.entry.get.token_required`      | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | session entry get                                        |
| local | `cli.tracking.session.entry.get.indeterminate`       | The answer is lost. Repeat the read.                                                                                                                                 | session entry get                                        |
| local | `cli.tracking.analytics.cost.invalid_project_id`     | `--project` is not a `ProjectID`.                                                                                                                                    | analytics cost                                           |
| local | `cli.tracking.analytics.cost.invalid_node_id`        | `--node` is not a `NodeID`.                                                                                                                                          | analytics cost                                           |
| local | `cli.tracking.analytics.cost.invalid_query`          | `--group-by`, `--bucket`, `--from` or `--to` is not a value of its set or Unix milliseconds.                                                                         | analytics cost                                           |
| local | `cli.tracking.analytics.cost.token_required`         | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | analytics cost                                           |
| local | `cli.tracking.analytics.cost.indeterminate`          | The answer is lost. Repeat the read.                                                                                                                                 | analytics cost                                           |
| local | `cli.tracking.analytics.duration.invalid_project_id` | `--project` is not a `ProjectID`.                                                                                                                                    | analytics duration                                       |
| local | `cli.tracking.analytics.duration.invalid_node_id`    | `--node` is not a `NodeID`.                                                                                                                                          | analytics duration                                       |
| local | `cli.tracking.analytics.duration.invalid_query`      | `--measure` is missing, or `--measure`, `--group-by`, `--bucket`, `--from` or `--to` is not a value of its set or Unix milliseconds.                                 | analytics duration                                       |
| local | `cli.tracking.analytics.duration.token_required`     | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                                                                                    | analytics duration                                       |
| local | `cli.tracking.analytics.duration.indeterminate`      | The answer is lost. Repeat the read.                                                                                                                                 | analytics duration                                       |
| local | `cli.pagination.limit_invalid`                       | `--limit` is not a positive integer.                                                                                                                                 | span list, timeline list, trace list, session entry list |
| local | `cli.pagination.limit_out_of_range`                  | `--limit` is outside 1 to 1000 for `span list`, `timeline list`, `trace list` and `session entry list`.                                                              | span list, timeline list, trace list, session entry list |
| 400   | `system.pagination.cursor_invalid`                   | `--cursor` is not a cursor of this listing.                                                                                                                          | span list, timeline list, trace list, session entry list |
| 400   | `tracking.filter.range_invalid`                      | `from` is after `to`.                                                                                                                                                | trace list, timeline list                                |
| 400   | `tracking.filter.range_invalid`                      | The range of `from` and `to` is longer than 31 days, or `from` is after `to`.                                                                                        | analytics cost, analytics duration                       |
| 400   | `gateway.request.validation_failed`                  | `category` is `unattributed` or unknown, or `reason` is blank or has more than 4096 characters.                                                                      | cause label                                              |
| 400   | `tracking.cause.subcategory_mismatch`                | `subcategory` is not in the set of `category`.                                                                                                                       | cause label                                              |
| 409   | `tracking.cause.trace_open`                          | The state of the trace is `open`.                                                                                                                                    | cause label                                              |
| 404   | `tracking.trace.not_found`                           | The trace is unknown.                                                                                                                                                | all                                                      |
| 404   | `tracking.text.not_found`                            | The trace holds no such text.                                                                                                                                        | text get                                                 |
| 404   | `tracking.entry.not_found`                           | The session holds no such entry.                                                                                                                                     | session entry get                                        |

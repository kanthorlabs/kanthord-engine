# Tracking Service CLI specification

This page specifies the `kanthord tracking` command group and the Tracking
operations. Start with [the CLI specification index](./README.md) and
[shared CLI conventions](./other.md).

## Status and scope

**Implemented:** the Tracking Service owns `tracking.db`, a database file in the
data directory beside `kanthord.db`. It holds the tables of
[ERD 4](https://github.com/kanthorlabs/kanthord/blob/main/docs/reference/erd/04-tracking.md):
`tracking_trace`, `tracking_span`, `tracking_record` and
`tracking_telemetry_text`. The server opens and migrates the file at start.

- The Scheduler Service opens the root span of an execution after the claim and
  ends it at the release or at the loss of the claim. A failed root write never
  fails the claim or the release. The Tracking Service counts the drop.
- A native worker writes its spans and telemetry texts with
  `tracking.telemetry.write` during its live execution. The operation is
  API-only.
- A human reads a trace, its spans and its telemetry texts with the three CLI
  leaves below.

Telemetry is lossy and has no current effect. It is not Mission evidence,
assessment or outcome. It completes no node, renews no claim and authorizes no
operation. An absent span proves nothing, and a read never promises a complete
trace.

**Later work:** the capture of an external harness and the human-issued
`telemetry ingest` follow the root
[worker contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/explanation/worker-contract.md).
The ingestion reuses the record schema of `tracking.telemetry.write` and adds
`execution_id`. The retention sweep and the trace deletion wait for the
retention values in the root
[HANDOFF](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service).

## Command inventory and operation mapping

The literal service prefix is `/api/tracking`. Read requests have no body.

| Command suffix / synopsis                                    | Operation identifier | HTTP route                                        | Access / effect |
| ------------------------------------------------------------ | -------------------- | ------------------------------------------------- | --------------- |
| `trace get <trace-id>`                                       | `tracking.trace.get` | `GET /api/tracking/trace/:trace_id`               | `human`; read   |
| `span list <trace-id> [--limit <count>] [--cursor <opaque>]` | `tracking.span.list` | `GET /api/tracking/trace/:trace_id/span`          | `human`; read   |
| `text get <trace-id> <text-id>`                              | `tracking.text.get`  | `GET /api/tracking/trace/:trace_id/text/:text_id` | `human`; read   |

API-only operation:

| Operation identifier       | HTTP route                                             | Access / effect                                                       |
| -------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `tracking.telemetry.write` | `POST /api/tracking/execution/:execution_id/telemetry` | `client` with the execution proof; mutation, idempotency key required |

## Synopses

```text
kanthord tracking [--help]

kanthord tracking trace get <trace-id>
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking span list <trace-id> [--limit <count>] [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking text get <trace-id> <text-id>
  [--endpoint <url>] [--token <jwt>] [--help]
```

Each leaf and group supports `--help` without a server or credential. A leaf
rejects unknown arguments and options before work.

### Identity and timestamp validation

- `TraceID` is 32 and `SpanID` is 16 lower-case hexadecimal characters, never
  all zero. The Scheduler mints both at the claim.
- `RecordID` and `TextID` have the form `<span_id>:<name>`. The name starts with
  a lower-case letter and holds lower-case letters, digits, `_` and `.`. The
  whole value is at most 128 characters. A span record uses
  `<span_id>:start` and `<span_id>:end`. A text uses
  `<span_id>:<text name>`, and its record identity equals its text identity.
- `Timestamp` is a JSON integer of Unix milliseconds in UTC.
- `AttributeValue` is a string, a boolean, a safe integer, a finite number, or
  an array of at most 128 values of one primitive kind. Attribute names reuse
  the OpenTelemetry conventions. Kanthord identity attributes use the
  `kanthord.` prefix.

## `trace get`

Reads the header of one trace: `trace_id`, `project_id`, `execution_id`,
`root_span_id` and `created_at`. An unknown trace answers `404`
`tracking.trace.not_found`.

## `span list`

Reads one page of the stored spans of a trace, oldest first. `--limit` is 1 to
1000 and defaults to 500. `next_cursor` is `null` on the last page. Each span
holds `trace_id`, `span_id`, `parent_span_id`, `producer`, `origin`,
`operation`, `start_time`, `end_time`, `status`, `attributes`, `events`,
`links`, `text_ids` and `created_at`. A span with a start and no end is an
operation that still runs. The parent of a span can be absent from the page or
from the store.

## `text get`

Reads one telemetry text. The answer holds `trace_id`, `text_id`, `content` and
`created_at`. A telemetry text has no state of its own. It expires with its
trace: one delete of the trace row removes its spans, texts and records. An
unknown text answers `404` `tracking.text.not_found`. An unknown or deleted
trace answers `404` `tracking.trace.not_found`.

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

### Output and failure conventions

The acknowledgement holds one disposition for each submitted record, in order,
and the counts `submitted`, `stored` and `refused`. A disposition is `Stored`
after the commit, or `Refused` with a reason. A refusal is structural and
permanent: retry the record only with a new identity and new content.

| Refusal reason     | Condition                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `trace_mismatch`   | The record names a trace other than the trace of the execution.                                   |
| `execution_bound`  | The trace already holds 50,000 records.                                                           |
| `record_too_large` | The canonical JSON of the record is larger than 64 KiB.                                           |
| `self_parent`      | The span names itself as its parent.                                                              |
| `foreign_producer` | Another producer created the span.                                                                |
| `value_replaced`   | The record changes the operation, the parent, a time, a status or an attribute value of the span. |
| `text_exists`      | The text already holds content.                                                                   |

One transaction applies the whole batch. A transport failure or a timeout
leaves every disposition unknown, and the producer retries the same records
with the same identities.

## Error codes

Every remote command can also answer the shared codes of
[other.md](other.md#error-codes).

| HTTP  | Code                                      | Condition                                                         | Commands  |
| ----- | ----------------------------------------- | ----------------------------------------------------------------- | --------- |
| local | `cli.tracking.trace.get.invalid_trace_id` | The `<trace-id>` argument is not a `TraceID`.                     | trace get |
| local | `cli.tracking.span.list.invalid_trace_id` | The `<trace-id>` argument is not a `TraceID`.                     | span list |
| local | `cli.tracking.text.get.invalid_trace_id`  | The `<trace-id>` argument is not a `TraceID`.                     | text get  |
| local | `cli.tracking.text.get.invalid_text_id`   | The `<text-id>` argument is not a `TextID`.                       | text get  |
| local | `cli.tracking.trace.get.token_required`   | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`. | trace get |
| local | `cli.tracking.span.list.token_required`   | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`. | span list |
| local | `cli.tracking.text.get.token_required`    | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`. | text get  |
| local | `cli.tracking.trace.get.indeterminate`    | The answer is lost. Repeat the read.                              | trace get |
| local | `cli.tracking.span.list.indeterminate`    | The answer is lost. Repeat the read.                              | span list |
| local | `cli.tracking.text.get.indeterminate`     | The answer is lost. Repeat the read.                              | text get  |
| local | `cli.pagination.limit_invalid`            | `--limit` is not a positive integer.                              | span list |
| local | `cli.pagination.limit_out_of_range`       | `--limit` is outside 1 to 1000.                                   | span list |
| 400   | `system.pagination.cursor_invalid`        | `--cursor` is not a cursor of this listing.                       | span list |
| 404   | `tracking.trace.not_found`                | The trace is unknown.                                             | all       |
| 404   | `tracking.text.not_found`                 | The trace holds no such text.                                     | text get  |

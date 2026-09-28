# Tracking Service CLI specification

This page specifies the future `kanthord tracking` command group. Start with
[the CLI specification index](./README.md) and
[shared CLI conventions](./other.md). It is an engine contributor specification,
not a claim that these commands are available today.

## Status and scope

**Implemented, inspected 2026-09-23:** `kanthord tracking` is a help-only group.
The [CLI dispatcher](../../src/apps/cli/index.ts) registers `--endpoint <url>`
and help, with no Tracking subcommands or token handling. There is no
`src/tracking/` implementation, Tracking operation contract, Tracking database
initialization, or Tracking OpenAPI document. The
[server composition](../../src/apps/server/index.ts) constructs Project, Worker,
and Gateway services. The design's initial no-op tracer phase is not evidence
that a tracer interface has already shipped.

**Design requirements:** Tracking owns telemetry: traces, spans, telemetry text,
ingestion acknowledgements, retention, and recorded drops. Telemetry is lossy
and has no current effect. It is not Mission evidence, assessment, or outcome;
it cannot complete a node, renew a lease, validate progress, or authorize a
resource operation. An absent span proves nothing. Reads never promise a
complete trace.

**Proposed:** all seven leaf commands below, their operation identifiers, HTTP
paths, JSON field names, read projections, filters, and numerical limits marked
as proposals. The design establishes human-issued ingestion and human trace
reading, but declares no Tracking command table or wire schema. Listing,
individual span/text retrieval, and filtered queries are proposed projections
of that read capability. Each needs an owning `contract.ts` operation and
generated OpenAPI before implementation. A proposed route is not a published
route. Command contracts remain **blocked** under [HANDOFF Tracking Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service).

[tracking-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service

## Command table

All names in this table are **proposed**, all routes are remote, and all access
policies are `human`. An authenticated human has the system's server-owner
authority; Tracking adds no roles or project-membership model. Project-scoped
and projectless traces use the same read policy. Ingestion checks the requester's
current authorization for each record's resolved project, independently of the
claim's state.

| Command after `kanthord tracking` | Proposed operation                                           | Proposed HTTP route                             | Access  | Output and effects                                                                        |
| --------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `telemetry ingest`                | `tracking.telemetry.ingest` **[blocked][tracking-contract]** | `POST /api/tracking/telemetry/ingest`           | `human` | Mutates telemetry only; returns one disposition per submitted record and a batch summary. |
| `trace list`                      | `tracking.trace.list` **[blocked][tracking-contract]**       | `GET /api/tracking/trace`                       | `human` | Bounded page of trace summaries, optionally filtered by project or execution.             |
| `trace get`                       | `tracking.trace.get` **[blocked][tracking-contract]**        | `GET /api/tracking/trace/:traceId`              | `human` | Trace header and known root reference; spans are read through bounded pages.              |
| `span list`                       | `tracking.span.list` **[blocked][tracking-contract]**        | `GET /api/tracking/trace/:traceId/span`         | `human` | Bounded page of stored spans in one trace.                                                |
| `span get`                        | `tracking.span.get` **[blocked][tracking-contract]**         | `GET /api/tracking/trace/:traceId/span/:spanId` | `human` | One stored span, including its provenance and unresolved references.                      |
| `span query`                      | `tracking.span.query` **[blocked][tracking-contract]**       | `POST /api/tracking/trace/:traceId/span/query`  | `human` | Read-only bounded query over stored spans; no mutation or derived measurement.            |
| `text get`                        | `tracking.text.get` **[blocked][tracking-contract]**         | `GET /api/tracking/trace/:traceId/text/:textId` | `human` | One telemetry text or its known-expired/unknown state.                                    |

The `POST` query is a read: it declares `mutation: false` and takes no
idempotency key. Ingestion declares `mutation: true`. No CLI command exposes
the internal server telemetry sink as a way to impersonate a service producer.
The sink uses a service identity through the direct adapter under the [invocation ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-operation-and-its-two-entry-adapters).

## Synopses

```text
kanthord tracking [--help]

kanthord tracking telemetry ingest --file <path>
  [--idempotency-key <key>] [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking trace list [--project <project-id> | --projectless]
  [--execution <execution-id>] [--limit <count>] [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking trace get <trace-id>
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking span list <trace-id> [--limit <count>] [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking span get <trace-id> <span-id>
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking span query <trace-id> --file <path>
  [--limit <count>] [--cursor <opaque>]
  [--endpoint <url>] [--token <jwt>] [--help]

kanthord tracking text get <trace-id> <text-id>
  [--endpoint <url>] [--token <jwt>] [--help]
```

Each leaf and nested group supports `--help` without a server or credential.
Proposed commands reject unknown arguments/options, missing required values,
and `--config` before work. They read no prompt or implicit standard input.
`import`, `tail`, and `follow` are not aliases in this proposal.

## Shared arguments, flags, and scalar types

Shared syntax, types, defaults, and validation are defined by each linked flag.
Tracking-specific applicability and requirements are:

| Common flag                                                                      | Applies to / Tracking requirement                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every remote command.                                                                                                                                                     |
| [`--token`](./common-flags.md#--token)                                           | Ingestion requires a nonblank resolved human JWT by design. The read commands propose the `human` access policy; the Tracking design does not settle machine read access. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                                                                                                     |
| [`--file`](./common-flags.md#--file)                                             | Required on `telemetry ingest` and `span query`; fields and limits are defined below.                                                                                     |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Ingestion only; the POST query is read-only.                                                                                                                              |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Lists and `span query`.                                                                                                                                                   |

The following definitions cover command-specific arguments and filters. A flag
requiring a value cannot be supplied as a bare switch. Unless a row states
otherwise, an omitted optional value stays absent rather than being sent as
`null`.

| Argument or flag             | Requiredness and type                               | Default                        | Validation and request mapping                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<trace-id>`                 | Required `TraceID` positional argument              | None                           | Map to `params.traceId`; exact entity-kind validation awaits Tracking's prefix declaration. No trace-name lookup or bare ULID.                                                                                                                                                                           |
| `<span-id>`                  | Required `SpanID` positional argument on `span get` | None                           | Map to `params.spanId`; the span belongs to the named trace. Prefix declaration remains **[blocked][tracking-contract]**.                                                                                                                                                                                |
| `<text-id>`                  | Required `TextID` positional argument on `text get` | None                           | Map to `params.textId`; the text belongs to the named trace. Prefix declaration remains **[blocked][tracking-contract]**.                                                                                                                                                                                |
| `--project <project-id>`     | Optional `ProjectID` on `trace list`                | Absent: no project filter      | Send `query.projectId`. Incompatible with `--projectless`; a filter grants no authority.                                                                                                                                                                                                                 |
| `--projectless`              | Optional boolean switch on `trace list`             | `false`: no projectless filter | When present, send `query.projectless=true`. Select only traces belonging to no project; incompatible with `--project`.                                                                                                                                                                                  |
| `--execution <execution-id>` | Optional `ExecutionID` on `trace list`              | Absent: no execution filter    | Send `query.executionId`. Combine supplied filters by AND. Correlation grants no authority. `ExecutionID` uses `execution_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service). |

The [shared client-file rules](./other.md#cliyaml-and-its-effects) apply.
These commands neither open server databases nor update client/server
configuration.

### Identity and timestamp validation

- An opaque kanthord entity identity has the form `<declared-prefix>_<ulid>`.
  The canonical suffix matches `[0-7][0-9A-HJKMNP-TV-Z]{25}`. The
  [shared identity scalar](../../src/kernel/identity.ts) validates the exact
  entity prefix as well as the suffix. Bare ULIDs and a different kind's prefix
  are invalid entity IDs.
- `ProjectID` uses the declared `project_` prefix. `ExecutionID` uses
  `execution_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service).
  `TraceID`, `SpanID`, `TextID`, and producer-minted `RecordID` are symbolic types
  here, not new prefix declarations. Their identity contracts remain **[blocked][tracking-contract]**.
- OpenTelemetry reuse does not by itself declare W3C hexadecimal trace/span
  IDs as the entity IDs accepted here. Protocol mapping remains **[blocked][tracking-contract]**.
- `Timestamp` composes the
  [shared timestamp scalar](../../src/kernel/json.ts): a JSON integer of Unix
  milliseconds in UTC, in `0..Number.MAX_SAFE_INTEGER`. Neither a timestamp nor
  a ULID establishes causal order. A reader must not infer a duration by
  subtracting wall-clock timestamps.
- `AttributeValue` is a string, boolean, safe integer, finite floating-point
  number, or an array of a single primitive kind. Objects, `null`, nested
  arrays, and mixed-kind arrays are invalid. The safe-integer restriction is a
  proposed JSON representation constraint. Empty arrays are proposed as
  valid; their element-kind representation remains **[blocked][tracking-contract]**.
  Attribute names reuse OpenTelemetry conventions; kanthord identity
  attributes use the `kanthord.` namespace. Identity values name objects and
  never embed their contents.

## `telemetry ingest`: one finite import batch

This proposed command imports a named JSON snapshot prepared from an external
harness capture. The spelling is `ingest`; its effect is the design's finite
import. It makes one bounded API call, rather than starting an uploader or
watching an execution. The input file is read once before dispatch and is not
rewritten or deleted by this command. Its top-level object maps directly to the
JSON request body; the operation has no path parameters or query parameters.

The extension captures what its harness exposes, including authored prose,
best effort. Its bounded, append-only local log records the server-issued trace
and root-span references with captures. One writer owns that log; it rotates
segments and discards the oldest whole segments at the local bound. Capture
durability follows bounded `fsync`, not merely append. An ingestion fixes its
endpoint at the last record present when it starts. Later captures await the
next human-issued ingestion. A reader reports an incomplete tail and never
repairs it; the writer owns repair.

The JSON file below is a **proposed batch interchange format**, not the log's
newline-framed storage format. External ingestion packaging remains **blocked** under the [HANDOFF harness-integration item](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery). Repeating this command for a later batch requires its
own idempotency key. It creates no server-side ingestion job, progress resource,
or resumable upload session.

### Proposed file schema

Every wire name and numeric cap in this subsection is **proposed pending
contract/OpenAPI**. The design requires finite record and byte bounds but
supplies no numerical values. Proposed limits for this command are a
`1 MiB` file/request body, `1..1000` records, and `64 KiB` per encoded record.
The implementation must bound both original file bytes and transmitted JSON
bytes. Reject an oversized file before dispatch; do not silently truncate prose
or drop records to make it fit. Execution, log, segment and retention bounds remain **[blocked][tracking-contract]**.

Objects are strict at the envelope and record-schema levels: reject duplicate
JSON member names, unknown fields, invalid Unicode, and invalid types. Attribute
maps intentionally have variable keys. Schema checks concern structure, not
the merit or subject matter of captured content. The service imposes no prose
moderation, assessment, or evidence-validation policy.

| Field                   | Requiredness and type                           | Default | Validation and meaning                                                                                                                                  |
| ----------------------- | ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`               | Required array of span or text records          | None    | `1..1000` entries, subject to the byte caps. Order is delivery order, not causal order.                                                                 |
| `records[].recordId`    | Required `RecordID` string                      | None    | Producer-minted stable record identity; retain it on redelivery. The identity contract remains **[blocked][tracking-contract]**.                        |
| `records[].executionId` | Required `ExecutionID` string                   | None    | Correlates the external execution; must resolve consistently with `traceId`. A claim need not still be live.                                            |
| `records[].traceId`     | Required `TraceID` string                       | None    | Existing server-assigned trace of that execution. The service resolves its project from its own records; the request assigns neither project nor trace. |
| `records[].kind`        | Required enum string, proposed `span` or `text` | None    | Selects exactly one variant below. A text record has no span-variant fields and vice versa.                                                             |

`projectId`, `producer`, claim credentials, requester identity, and arbitrary
resource credentials are not accepted input fields. A human's authorization
permits import; it does not make the human the producer. Tracking derives an
imported record's producer from the claimant of the resolved execution.

#### Span record fields (`kind: "span"`)

The common fields above and the following fields constitute the whole proposed
span-record schema.

| Field                 | Requiredness and type                             | Default                           | Validation and meaning                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spanId`              | Required `SpanID`                                 | None                              | Identity owned by the derived producer after the first accepted record creates it.                                                                                                                                                                                            |
| `operation`           | Required nonempty string                          | None                              | Name of one operation, proposed maximum 256 UTF-8 bytes. A subsequent record cannot replace the established name.                                                                                                                                                             |
| `parentSpanId`        | Required `SpanID`                                 | None                              | An imported execution span names its server root or a descendant as parent. Reject `null` and self-parenting in this proposed external-import schema. Unresolved parents are allowed; the service verifies no further ancestry. The server's root-writing schema is separate. |
| `startTime`           | Optional `Timestamp`                              | Absent                            | Start time only when captured. At least one of `startTime` and `endTime` is required by this proposed record format.                                                                                                                                                          |
| `endTime`             | Optional `Timestamp`                              | Absent                            | End time only when captured. An end without a start creates a span with no start time. A second end with a different record identity is refused.                                                                                                                              |
| `attributes`          | Optional object mapping names to `AttributeValue` | Absent: adds nothing              | Proposed maximum 128 keys, each nonempty and at most 256 UTF-8 bytes. Existing values cannot be replaced. Authored prose belongs in text records rather than attributes. Total record-byte cap bounds values.                                                                 |
| `events`              | Optional array of event objects                   | Absent: adds nothing              | Proposed maximum 128 entries. No event identity or deduplication scheme beyond the containing record is introduced.                                                                                                                                                           |
| `events[].name`       | Required nonempty string                          | None                              | Proposed maximum 256 UTF-8 bytes; names the observed event.                                                                                                                                                                                                                   |
| `events[].time`       | Required `Timestamp`                              | None                              | Proposed explicit event observation time.                                                                                                                                                                                                                                     |
| `events[].attributes` | Optional attribute object                         | Absent: no attributes             | Same name, value-kind, count, and aggregate-byte constraints as `attributes`.                                                                                                                                                                                                 |
| `status`              | Optional enum string: `Unset`, `Ok`, `Error`      | Absent: supplies no status update | Preserve an existing status; never treat an omitted value as an overwrite. Display an unset result as `Unset` when no status was recorded. Status update rules remain **[blocked][tracking-contract]**.                                                                       |
| `links`               | Optional array of link objects                    | Absent: adds nothing              | Proposed maximum 128 entries. A link refers to a span in another trace and names no project.                                                                                                                                                                                  |
| `links[].traceId`     | Required `TraceID`                                | None                              | Target trace reference; proposed validation requires a different trace from the containing record. No linked-trace completeness guarantee.                                                                                                                                    |
| `links[].spanId`      | Required `SpanID`                                 | None                              | Target span reference. Naming it changes no span or authority.                                                                                                                                                                                                                |
| `textIds`             | Optional array of `TextID`                        | Absent: adds nothing              | Proposed maximum 128 distinct references. Each text belongs to this trace; never embed text content in the span. Arrival order need not resolve every reference immediately.                                                                                                  |

Optional collection omission means no contribution, not deletion. An empty
collection contributes nothing. A start-only record makes an unfinished span
readable immediately; it does not wait for its end or for the root to close.
Changing a previously set value is not an update facility. Merge and status-finalization rules remain **blocked** under [HANDOFF Tracking Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service).

#### Text record fields (`kind: "text"`)

| Field    | Requiredness and type               | Default | Validation and meaning                                                                                                                                              |
| -------- | ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textId` | Required `TextID`                   | None    | Identity of a telemetry text belonging to `traceId`; any number of that trace's spans can reference it.                                                             |
| `text`   | Required well-formed Unicode string | None    | Proposed to allow an empty capture. Encoded record must fit `64 KiB`; no prose-based rejection, truncation, automatic evidence creation, or content interpretation. |

The file has no producer selector, project selector, retention override,
trace-creation switch, or overwrite switch. Large transcripts remain **blocked** under [HANDOFF Tracking Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service).

### Acknowledgement, effects, and retry

The design's closed record disposition set is `Stored` and `Refused`:

- `Stored` follows durable storage, never mere receipt. A duplicate record is
  `Stored`; deduplication holds within the trace's retention.
- `Refused` means permanently unacceptable for a structural reason. Examples
  include a trace/execution mismatch, another producer's span identity,
  self-parenting, a second end, an expired trace, or the execution record cap.
  A refusal is not evidence that an execution failed.
- A transient transport/server failure is not a third disposition. Records
  without an acknowledged disposition remain retained for retry. Pressure can
  lose telemetry; the server counts drops, and that telemetry can also be lost.

**Proposed CLI output:** one JSON object containing `idempotencyKey`,
`dispositions` (entries with `recordId`, `disposition`, and an optional coded
structural refusal reason), and counts `submitted`, `stored`, `refused`, and
`retained`. Counts are nonnegative integers for this submitted batch only;
`retained` counts records without a known disposition. A complete valid
acknowledgement supplies exactly one entry for every submitted record and
therefore has `retained: 0`. It reports neither the total contents of an
extension's local log nor a complete execution's telemetry.

The extension deletes or advances its local acknowledged prefix only after
receiving a disposition, for both `Stored` and `Refused`. It updates its local
cursor after the answer, so a crash before that update can repeat delivery.
Records discarded by the local bound are reported as discarded, not retained.
This file-oriented CLI has no authority to advance an extension's cursor and
cannot infer its discarded count.
Acknowledgement handoff remains **blocked** under the [HANDOFF harness-integration item](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery).

The service stores no ingestion progress between calls. Reuse both record IDs
and the same `--idempotency-key` when retrying the same invocation with the same
authenticated caller and input. A newly generated key on another process run
does not request replay of the previous invocation. Target Gateway replay is in
memory and bounded by its TTL; after expiry or restart the handler runs again,
with Tracking's record deduplication providing the separate natural-key guard.
Reusing a key with changed input or while the original call is in progress can
return HTTP 409. The [shared replay rules](./other.md#idempotency-and-retries) apply.

The proposed CLI prints the generated key on success and in failure diagnostics.
An indeterminate answer preserves uncertainty and requires retry with that key;
it must not invent `Stored` or `Refused` entries. Local cancellation stops
further client work and does not undo already stored telemetry. Timeouts and partial acknowledgements remain **[blocked][tracking-contract]**. The command does not silently retry forever.

## Trace, span, and text reads

Read commands print JSON and change no domain record. Proposed HTTP success is
200; status mappings remain **[blocked][tracking-contract]**. No flag upgrades telemetry to evidence or converts
unknown state to an outcome.

### `trace list` and `trace get`

`trace list` returns a proposed `{items, nextCursor}` envelope, with at most
`limit` trace summaries. `nextCursor` is an opaque string or `null` at the end.
The optional filters are defined above; absence of both project selectors
includes project-scoped and projectless traces. It lists what is retained,
rather than asserting that every execution has a trace.

`trace get` returns the same proposed summary projection for one trace: trace
identity, resolved project or no project, known execution association, and root
span reference if known. It does not inline an unbounded span tree or transcript.
Use `span list` to assemble the readable trace. A trace has one root by design,
but a lost root write can leave an unresolved root reference. Do not manufacture
a root to fill that gap or fail otherwise readable child spans.

Lists use the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
Missing-root representation remains **[blocked][tracking-contract]**. A cursor is
not a causal watermark and is not the extension's local ingestion cursor.

### `span list` and `span get`

`span list` returns a proposed `{items, nextCursor}` page under the specified
trace. `span get` returns one span under that same scope, never a span from a
different trace. Both project each stored span's identity, operation, recorded
start/end times, parent reference, attributes, events, status, cross-trace links,
text references, and server-derived producer/provenance. Missing start or end
data stays missing; a start without an end is unfinished. The output must
distinguish server-observed telemetry from external-harness assertions.

The renderer preserves unresolved parents and links. It does not reject a page
because a referenced span is absent, expired, or arrived later. No inferred
duration, success classification, ancestry verification, or reconstructed prose
is added. Producer and reference schemas remain **blocked** under [HANDOFF Tracking Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service).
Historical claimant attribution follows [Scheduler Claims and counts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#claims-and-counts).

### `span query`: bounded structured inspection

This is a proposed read projection, not an arbitrary query language. It sends
the named JSON object's fields as the request body, `traceId` as the route
parameter, and `limit`/`cursor` as query parameters. The proposed maximum file
and request-body size is `64 KiB`; all objects are strict except attribute maps.
Unknown keys, duplicate keys, and invalid types fail before dispatch.

| File field   | Requiredness and type                                 | Default                             | Validation and semantics                                                                                                                                                                         |
| ------------ | ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `operation`  | Optional nonempty string                              | Absent: no operation filter         | Exact equality; proposed maximum 256 UTF-8 bytes. No regular expression or glob.                                                                                                                 |
| `status`     | Optional enum string: `Unset`, `Ok`, `Error`          | Absent: no status filter            | Equality on the read projection's status, not a Mission outcome.                                                                                                                                 |
| `hasEnd`     | Optional boolean                                      | Absent: either                      | `true` selects a recorded end; `false` selects no recorded end. Absence of an end establishes no execution failure.                                                                              |
| `attributes` | Optional map from attribute names to `AttributeValue` | Absent or `{}`: no attribute filter | Proposed maximum 128 keys with the same key/value validation as ingestion. All entries must match; missing attributes do not match. Array comparison is exact ordered equality, not containment. |

`{}` is a valid query and returns the same scope as `span list`. Multiple fields
combine by AND. Only equality and `hasEnd` are proposed; SQL, full-text search,
regex, grouping, aggregation, measurement derivation, wall-clock ranges, and
cross-project joins have no command contract here. Registered identity
attribute names can support object correlation, but their full canonical key
registry remains **[blocked][tracking-contract]**.

The response uses the same span projection and `{items, nextCursor}` envelope
as `span list`. A client keeps the same trace and filter document for a
continuation. The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) applies.

### `text get`

A telemetry text contains authored prose such as an agent transcript. A span
references it by identity and never embeds it. The proposed output has
`traceId`, `textId`, and `state` equal to `available`, `expired`, or `unknown`;
only `available` carries `text`. These are proposed response spellings, not new
record dispositions. A known text whose content expired must resolve as
expired, not unknown. The store retains the identity needed for that distinction.

The text retention is no longer than span retention, but neither duration is a
CLI default. The vocabulary's ninety-day span and seven-day text examples are
not configuration values. Retention and large-text read contracts remain **[blocked][tracking-contract]**. Transcript telemetry becomes evidence only
through the separately authorized Mission/Worker evidence workflow.

## Streaming and operational inspection boundaries

Hosted streaming remains **blocked** under [HANDOFF Worker Service, Next phase](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#next-phase).
This page declares no stream command.

An external harness keeps its capture locally until a human issues an import.
A reader can subsequently see admitted records; this is not live streaming of
that external program. Ending an execution does not require waiting for an
import, and server-observed spans remain independently readable.

Operational inspection uses these stored read projections: unfinished spans,
recorded error statuses, provenance, unresolved references, text expiry, and
acknowledgement/refusal counts. Tracking records measurements produced by other
services and derives no measurement. Drop/discard counters are telemetry and
can themselves be absent. There is no declared counter-query schema or dedicated
Tracking statistics/status operation.

Server component health belongs to the ruled [`gateway.liveness` operation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#component-healthchecks),
`GET /api/liveness`, access `public`; the source serves this
contract as `gateway.liveness` at `GET /api/liveness`, declared in the
[Gateway contract](../../src/gateway/contract.ts). It reports registered
components, not fictitious health for an absent Tracking service. Tracking is
an internal component, not an external resource, so it has no resource
healthcheck. See [shared operational commands](./other.md) for the CLI-wide
conventions. The operational log is separate from telemetry; this group
provides no log-tail API.

Retention is server-wide and separately configured for spans and text. The
working tracer's future `tracking.db` is separate from operational state, with
bounded import transactions and retention sweeps. A trace is the deletion unit;
deleting it removes its spans and text, without removing Mission evidence or
changing an outcome. Those ownership and maintenance rules do **not** declare
an operator CLI action. No retention-set, sweep, prune, purge, span-delete,
trace-delete, repair, vacuum, or local database-inspection command is proposed.

## Output and failure conventions

The proposed commands follow [shared output conventions](./other.md): machine
readable JSON on standard output and concise diagnostics on standard error.
Normal successful reads and a fully `Stored` import exit `0`. The proposed
ingestion CLI exits `1` for any `Refused` or retained/unacknowledged records,
while preserving a valid acknowledgement in JSON when one exists. This exit
policy is a CLI proposal; an API call can successfully return `Refused` records.

Input, file, authentication, authorization, transport, and operation failures
exit nonzero. No parse/transport failure is reported as an empty successful
page. Failure output preserves the server's coded error and request identity
when available, without printing tokens or the submitted telemetry content.
An indeterminate mutation is distinguished from a known refusal and carries
the reusable idempotency key. This proposal uses the shared `0`/`1` exit codes;
the partial-output format must be adopted with the operation contract.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP | Code | Condition                | Commands          |
| ---- | ---- | ------------------------ | ----------------- |
| —    | —    | No code is declared yet. | proposed commands |

## Optional design provenance

The rules needed to read this page are stated above. These links record their
origin and are not required local files in a standalone engine checkout:

- [Tracking design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/tracking-service.md)
- [Tracking vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/tracking-service.vocabulary.md)
- [Tracking implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/tracking-service.impl.md)
- [Architecture implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
- [Open-work handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md)

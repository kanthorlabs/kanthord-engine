# Footprint Service CLI specification

This page specifies the `kanthord footprint` command group and the Footprint
operations. Start with [the CLI specification index](./README.md) and
[shared CLI conventions](./other.md).

## Status and scope

**Implemented:** the Footprint Service answers the statistics of each footprint
kind, proposes cleanup candidates by a rule, records each cleanup and calls the
delete operation of the owner of the kind. It deletes no data itself, and no
timer, start or alert deletes data. A cleanup deletes only the keys that a human
confirms.

- The server measures the server kinds at its start and every 15 minutes.
  `measure run` measures them at once.
- The statistics of the server hold `operational_database`, `trace`,
  `database_backup`, the server `log`, `environment`, `cache_volume`,
  `slot_image`, `intake_mirror`, `workbench` and the `disk` of each device.
- The unit of each instance measures `workspace`, `tool_output`, the instance
  `log` and `slot_residue` at its start and every 15 minutes, and reports them
  through `worker.footprint.report`. At the `worker` placement, the unit also
  measures `session` and its `disk`. At the `server` and `container`
  placements, the server measures `session`. See
  [worker.md](worker.md#instance-footprint-outside-the-cli-inventory).
- The candidates of an instance kind cover the oldest 10000 items of the last
  report. A `count` above 10000 marks a kind with more items.
- The service evaluates the alert state of each kind, host and item after
  each measurement. See [Alerts](#alerts).
- The `environment` kind offers the rules `unbound` and `superseded`. The rule
  `dangling` is not offered until a field check confirms that Podman keeps the
  owner label on a dangling image.

## Command inventory and operation mapping

The literal service prefix is `/api/footprint`. Read requests have no body.

| Command suffix / synopsis                                                                                                 | Operation identifier          | HTTP route                                        | Access / effect                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `summary`                                                                                                                 | `footprint.summary.get`       | `GET /api/footprint`                              | `human`; read                               |
| `kind get <kind> [--instance <name>]`                                                                                     | `footprint.kind.get`          | `GET /api/footprint/kind/:kind`                   | `human`; read                               |
| `candidate list <kind> [--instance <name>] [--rule <rule>] [--older-than-days <n>] [--limit <count>] [--cursor <opaque>]` | `footprint.candidate.list`    | `GET /api/footprint/kind/:kind/candidate`         | `human`; read                               |
| `item list <kind> [--instance <name>] [--limit <count>] [--cursor <opaque>]`                                              | `footprint.item.list`         | `GET /api/footprint/kind/:kind/item`              | `human`; read                               |
| `cleanup create <kind> [--instance <name>] (--rule <rule> [--older-than-days <n>] \| --file <path>)`                      | `footprint.cleanup.create`    | `POST /api/footprint/cleanup`                     | `human`; mutation, idempotency key required |
| `cleanup get <cleanup-id>`                                                                                                | `footprint.cleanup.get`       | `GET /api/footprint/cleanup/:cleanup_id`          | `human`; read                               |
| `cleanup list [--kind <kind>] [--limit <count>] [--cursor <opaque>]`                                                      | `footprint.cleanup.list`      | `GET /api/footprint/cleanup`                      | `human`; read                               |
| `cleanup cancel <cleanup-id>`                                                                                             | `footprint.cleanup.cancel`    | `POST /api/footprint/cleanup/:cleanup_id/cancel`  | `human`; mutation, idempotency key required |
| `alert list [--open] [--limit <count>] [--cursor <opaque>]`                                                               | `footprint.alert.list`        | `GET /api/footprint/alert`                        | `human`; read                               |
| `alert acknowledge <alert-id>`                                                                                            | `footprint.alert.acknowledge` | `POST /api/footprint/alert/:alert_id/acknowledge` | `human`; mutation, idempotency key required |
| `measure run`                                                                                                             | `footprint.measure.run`       | `POST /api/footprint/measure`                     | `human`; mutation, idempotency key required |

API-only operation:

| Operation identifier      | HTTP route                          | Access / effect                             |
| ------------------------- | ----------------------------------- | ------------------------------------------- |
| `footprint.backup.delete` | `POST /api/footprint/backup/delete` | `human`; mutation, idempotency key required |

## Kinds

| Kind                   | Host     | Owner delete operation                    | Rules                   |
| ---------------------- | -------- | ----------------------------------------- | ----------------------- |
| `operational_database` | server   | none                                      | none                    |
| `trace`                | server   | `tracking.trace.delete`                   | `older_than`            |
| `database_backup`      | server   | `footprint.backup.delete`                 | `older_than`            |
| `log`                  | server   | none; the operator rotates the file       | none                    |
| `environment`          | server   | `project.environment.delete`              | `unbound`, `superseded` |
| `cache_volume`         | server   | `project.environment.cache_volume.delete` | `unbound`               |
| `slot_image`           | server   | `worker.slot_image.delete`                | `superseded`            |
| `slot_residue`         | instance | none                                      | none                    |
| `intake_mirror`        | server   | none                                      | none                    |
| `workbench`            | server   | none                                      | none                    |
| `session`              | instance | `worker.instance.session.delete`          | `older_than`            |
| `workspace`            | instance | `worker.instance.workspace.delete`        | `node_closed`           |
| `tool_output`          | instance | `worker.instance.tool_output.delete`      | `older_than`            |
| `disk`                 | device   | none                                      | none                    |

The default age of `older_than` is 30 days for every kind.

## `summary`

`summary` prints one line for each kind, host and item. The tab-separated
fields are: kind, host (`server` or the instance name), item, count, size in
bytes, oldest time, growth in bytes per day, days to the floor, thresholds,
alert state, stale mark and measure error code. A `-` marks an absent value.

## `candidate list`

`candidate list` is the preview of a cleanup. It answers one page of the keys
that the rule selects, and the totals of the whole set. With no `--rule`, it
uses the first rule of the kind. A live key and the newest backup of each file
are not candidates. The `trace` totals are estimated from the mean trace size,
and `bytes_estimated` is `true`.

## `item list`

`item list` answers every item of a cleanable kind, oldest first. A live item
holds `refusal: "live"`. The newest backup of each file holds `kept: true`.

## `cleanup create`

`cleanup create` sends the request at once. It asks no question.

- `--rule` reads the candidate pages of the rule and sends their keys. A set of
  more than 1000 keys answers `cli.footprint.cleanup.create.too_many_keys`.
  Pass a larger `--older-than-days` to narrow the set.
- `--file` reads a JSON list of keys.
- The answer is the `queued` cleanup record with status 201. A background task
  calls the owner delete in batches of 20 keys, in key order.
- Each key ends as `removed`, `absent` or `refused` with a reason. The record
  moves to `completed` when each key holds a result. It moves to `failed` when
  the owner cannot run the order.
- An instance kind runs as one call. The session delete at the `server` and
  `container` placements answers the result at once. Every other instance
  delete queues an order, and the result arrives through
  `worker.footprint.report`.
- After a server restart, the task runs each `queued` and `running` record
  again from its stored outcome. For an instance kind, it sends the order to
  the Worker Service again.

## Alerts

The service evaluates each statistic after each measurement. An alert deletes
nothing and starts no cleanup.

- A kind with a bytes threshold in `footprint.thresholds` is above the
  threshold when its bytes exceed the value. The `log` value applies to each
  file. A `null` threshold turns the bytes alert of the kind off.
- The `disk` statistic of each device is above the threshold when
  `free_bytes / total_bytes` is below `footprint.disk_free_ratio`, or when
  `days_to_floor` is 30 or less. One episode for each device covers both
  conditions.
- A null value (bytes, free ratio or `days_to_floor`) is not above the
  threshold and counts as clear.
- The clear value is 0.9 times the threshold for bytes. It is the threshold
  divided by 0.9 for the free ratio and for `days_to_floor`. A `disk` statistic
  clears only when both conditions clear.

| From         | Condition at a measurement                           | To                          |
| ------------ | ---------------------------------------------------- | --------------------------- |
| `ok`         | above the threshold                                  | `pending`                   |
| `pending`    | above the threshold, 2 measurements in a row         | `firing`; insert an episode |
| `pending`    | at or below the threshold                            | `ok`                        |
| `firing`     | at or below the clear value                          | `recovering`                |
| `recovering` | at or below the clear value, 2 measurements in a row | `ok`; set `resolved_at`     |
| `recovering` | above the clear value                                | `firing`                    |

- A stale or a failed measurement changes no state.
- A `null` threshold sets the state `ok` and resolves an open episode.
- After each successful measurement of a host, the service resolves each open
  episode of that host whose item the measurement no longer reports.
- After a server restart, an open episode starts as `firing`.
- The episode records in `threshold` the condition that fired first, and in
  `value` its measured value at the fire.
- At each fire, the server logs `footprint.alert.fired` at level `warn`. At
  each resolve, it logs `footprint.alert.resolved` at level `info`. Each record
  holds `alert_id`, `kind`, `instance_name`, `item_key`, `value` and
  `threshold` of the episode.

`alert acknowledge` hides an open episode from the banner and the badge. The
answer holds `acknowledged_until` in bytes, rounded down.

- `disk`: the larger of half the free bytes and the floor bytes
  (`disk_free_ratio × total_bytes`). Below the floor, half the free bytes. The
  acknowledgement holds until the free bytes drop below `acknowledged_until`.
- A bytes kind: twice the bytes at the acknowledgement. The acknowledgement
  holds until the bytes reach `acknowledged_until`.
- After the acknowledgement ends, a new acknowledgement replaces the old one.
- A new episode after a resolve needs a new acknowledgement.

## `footprint.backup.delete`

A human deletes database backup files by name. The body is
`{ "names": [...] }` with 1 to 20 names of the form `<file>.bak-<stamp>`. The
answer is `{ "removed": <count>, "absent": <count> }`. A name that is not a
regular file beside its base file, for example a symlink, counts in `absent`
and stays. The candidate set and the dashboard keep the newest backup of each
file. The operation adds no refusal for a name that a human picks.

## Error codes

Every remote command can also answer the shared codes of
[other.md](other.md#error-codes).

| HTTP  | Code                                           | Condition                                                                                         | Commands                                            |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 404   | `footprint.instance.not_found`                 | No worker instance has the name.                                                                  | kind get, candidate list, item list, cleanup create |
| 409   | `footprint.instance.archived`                  | The instance is archived.                                                                         | cleanup create                                      |
| 409   | `footprint.kind.host_mismatch`                 | A server kind takes `--instance`, or an instance kind has no `--instance`.                        | candidate list, item list, cleanup create           |
| 409   | `footprint.rule.not_supported`                 | The rule does not apply to the kind.                                                              | candidate list, cleanup create                      |
| 404   | `footprint.cleanup.not_found`                  | No cleanup has the ID.                                                                            | cleanup get, cleanup cancel                         |
| 409   | `footprint.cleanup.not_queued`                 | The cleanup is not `queued`.                                                                      | cleanup cancel                                      |
| 404   | `footprint.alert.not_found`                    | No alert has the ID.                                                                              | alert acknowledge                                   |
| 409   | `footprint.alert.resolved`                     | The alert episode is resolved.                                                                    | alert acknowledge                                   |
| 409   | `footprint.alert.acknowledged`                 | The acknowledgement holds.                                                                        | alert acknowledge                                   |
| 400   | `gateway.request.validation_failed`            | A key list is empty, longer than 1000 keys or repeated, or a key has the wrong form for the kind. | cleanup create                                      |
| 400   | `system.pagination.cursor_invalid`             | The cursor belongs to another query.                                                              | candidate list, item list, cleanup list, alert list |
| local | `cli.footprint.cleanup.create.too_many_keys`   | The rule selects more than 1000 keys.                                                             | cleanup create                                      |
| local | `cli.footprint.cleanup.create.source_required` | The command has both or neither of `--rule` and `--file`.                                         | cleanup create                                      |
| local | `cli.footprint.cleanup.create.no_candidates`   | The rule selects no key.                                                                          | cleanup create                                      |
| local | `cli.footprint.<leaf>.token_required`          | No token resolves from `--token`, `KANTHORD_TOKEN` or `cli.yaml`.                                 | every command                                       |
| local | `cli.footprint.<leaf>.indeterminate`           | The answer is lost. Repeat a read, or repeat a mutation with the same idempotency key.            | every command                                       |

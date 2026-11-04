import assert from "node:assert/strict";
import type { Command } from "commander";
import { z } from "zod";
import { httpClient, resolveClient } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  ALERT_IDENTITY_PREFIX,
  CLEANUP_IDENTITY_PREFIX,
  identitySchema,
} from "../../kernel/identity.ts";
import {
  CleanableKind,
  cleanupCreateSchema,
  CleanupRule,
  type CleanupRuleValue,
  DEFAULT_AGE_DAYS,
  FOOTPRINT_CLEANUP_KEYS_MAX,
  FOOTPRINT_LIST_LIMIT_MAX,
  FootprintKind,
  footprintOperations,
  type FootprintStat,
  type FootprintThreshold,
} from "../../footprint/contract.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { addFileBodyHelp } from "./file-body.ts";
import {
  handleMutationResult,
  handleReadResult,
  parsePositiveInt,
  readTextFile,
  requireToken,
  resolveKey,
  singleUse,
} from "./shared.ts";

const SUMMARY = "summary";
const KIND = "kind";
const CANDIDATE = "candidate";
const ITEM = "item";
const CLEANUP = "cleanup";
const ALERT = "alert";
const MEASURE = "measure";
const GET = "get";
const LIST = "list";
const CREATE = "create";
const CANCEL = "cancel";
const ACKNOWLEDGE = "acknowledge";
const RUN = "run";
const KEY_OPTION = "--idempotency-key";
const ABSENT_FIELD = "-";
const COLUMN_SEPARATOR = "\t";
const STALE_MARK = "stale";
const DAY_DIGITS = 1;
const SERVER_HOST = "server";

type Options = Record<string, string | boolean | undefined>;

function code(leaf: string, suffix: string): string {
  return `cli.footprint.${leaf}.${suffix}`;
}

function client(command: Command, leaf: string) {
  const { endpoint, token } = resolveClient(command.optsWithGlobals());
  requireToken(token, code(leaf, "token_required"));
  return httpClient(footprintOperations, endpoint, token);
}

function parsed<T>(
  schema: z.ZodType<T>,
  value: unknown,
  leaf: string,
  name: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Diagnostic(code(leaf, `invalid_${name}`), `invalid ${name}`);
  return result.data;
}

function limitOf(options: Options): number | undefined {
  if (options.limit === undefined) return undefined;
  const limit = parsePositiveInt(
    options.limit as string,
    "cli.pagination.limit_invalid",
  );
  if (limit > FOOTPRINT_LIST_LIMIT_MAX)
    throw new Diagnostic(
      "cli.pagination.limit_out_of_range",
      `limit must be at most ${FOOTPRINT_LIST_LIMIT_MAX}`,
    );
  return limit;
}

function days(options: Options, leaf: string): number | undefined {
  return options.olderThanDays === undefined
    ? undefined
    : parsePositiveInt(
        options.olderThanDays as string,
        code(leaf, "invalid_older_than_days"),
      );
}

function present<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function cell(value: string | number | null): string {
  return value === null ? ABSENT_FIELD : String(value);
}

function thresholdText(thresholds: readonly FootprintThreshold[]): string {
  return thresholds.length
    ? thresholds.map((entry) => `${entry.measure}=${entry.value}`).join(",")
    : ABSENT_FIELD;
}

export function summaryLine(stat: FootprintStat): string {
  return [
    stat.kind,
    stat.instance_name ?? SERVER_HOST,
    cell(stat.item_key),
    cell(stat.count),
    cell(stat.bytes),
    stat.oldest_at === null
      ? ABSENT_FIELD
      : new Date(stat.oldest_at).toISOString(),
    stat.growth_per_day === null
      ? ABSENT_FIELD
      : String(Math.round(stat.growth_per_day.bytes)),
    stat.days_to_floor === null
      ? ABSENT_FIELD
      : stat.days_to_floor.toFixed(DAY_DIGITS),
    thresholdText(stat.thresholds),
    stat.alert.state,
    stat.stale ? STALE_MARK : ABSENT_FIELD,
    stat.measure_error?.code ?? ABSENT_FIELD,
  ].join(COLUMN_SEPARATOR);
}

async function summary(command: Command): Promise<void> {
  const result = await client(command, SUMMARY)["summary.get"]({
    params: {},
    query: {},
    body: null,
  });
  const data = handleReadResult(result, code(SUMMARY, "indeterminate"));
  for (const stat of data.stats) process.stdout.write(`${summaryLine(stat)}\n`);
}

async function kindGet(kind: string, command: Command): Promise<void> {
  const leaf = `${KIND}.${GET}`;
  const options = command.optsWithGlobals<Options>();
  const result = await client(command, leaf)["kind.get"]({
    params: { kind: parsed(z.enum(FootprintKind), kind, leaf, "kind") },
    query: present({ instance_name: options.instance as string | undefined }),
    body: null,
  });
  write(handleReadResult(result, code(leaf, "indeterminate")));
}

async function candidateList(kind: string, command: Command): Promise<void> {
  const leaf = `${CANDIDATE}.${LIST}`;
  const options = command.optsWithGlobals<Options>();
  const result = await client(command, leaf)["candidate.list"]({
    params: { kind: parsed(z.enum(CleanableKind), kind, leaf, "kind") },
    query: present({
      instance_name: options.instance as string | undefined,
      rule:
        options.rule === undefined
          ? undefined
          : parsed(z.enum(CleanupRule), options.rule, leaf, "rule"),
      older_than_days: days(options, leaf),
      limit: limitOf(options),
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  write(handleReadResult(result, code(leaf, "indeterminate")));
}

async function itemList(kind: string, command: Command): Promise<void> {
  const leaf = `${ITEM}.${LIST}`;
  const options = command.optsWithGlobals<Options>();
  const result = await client(command, leaf)["item.list"]({
    params: { kind: parsed(z.enum(CleanableKind), kind, leaf, "kind") },
    query: present({
      instance_name: options.instance as string | undefined,
      limit: limitOf(options),
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  write(handleReadResult(result, code(leaf, "indeterminate")));
}

function fileKeys(path: string, leaf: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(readTextFile(path));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Diagnostic(code(leaf, "invalid_file"), "invalid JSON document");
    throw error;
  }
  return parsed(z.array(z.string().min(1)).min(1), value, leaf, "file");
}

async function ruleKeys(
  command: Command,
  leaf: string,
  kind: CleanableKind,
  instanceName: string | undefined,
  rule: CleanupRuleValue,
): Promise<string[]> {
  const read = client(command, leaf)["candidate.list"];
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = handleReadResult(
      await read({
        params: { kind },
        query: present({
          instance_name: instanceName,
          rule: rule.name,
          older_than_days:
            rule.name === CleanupRule.OlderThan
              ? rule.older_than_days
              : undefined,
          limit: FOOTPRINT_LIST_LIMIT_MAX,
          cursor,
        }),
        body: null,
      }),
      code(leaf, "indeterminate"),
    );
    if (page.total_count > FOOTPRINT_CLEANUP_KEYS_MAX)
      throw new Diagnostic(
        code(leaf, "too_many_keys"),
        `the rule selects more than ${FOOTPRINT_CLEANUP_KEYS_MAX} keys; pass a larger --older-than-days`,
        { fields: [["count", page.total_count]] },
      );
    keys.push(
      ...page.items
        .filter((item) => item.refusal === null && !item.kept)
        .map((item) => item.key),
    );
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return keys;
}

async function cleanupCreate(kind: string, command: Command): Promise<void> {
  const leaf = `${CLEANUP}.${CREATE}`;
  const options = command.optsWithGlobals<Options>();
  const cleanable = parsed(z.enum(CleanableKind), kind, leaf, "kind");
  if ((options.rule === undefined) === (options.file === undefined))
    throw new Diagnostic(
      code(leaf, "source_required"),
      "pass exactly one of --rule and --file",
    );
  const instanceName = options.instance as string | undefined;
  let rule: CleanupRuleValue | null = null;
  let keys: string[];
  if (options.rule !== undefined) {
    const name = parsed(z.enum(CleanupRule), options.rule, leaf, "rule");
    const olderThan = days(options, leaf);
    const chosen: CleanupRuleValue =
      name === CleanupRule.OlderThan
        ? { name, older_than_days: olderThan ?? DEFAULT_AGE_DAYS }
        : { name };
    rule = chosen;
    keys = await ruleKeys(command, leaf, cleanable, instanceName, chosen);
    if (!keys.length)
      throw new Diagnostic(
        code(leaf, "no_candidates"),
        "the rule selects no key",
      );
  } else keys = fileKeys(options.file as string, leaf);
  const key = resolveKey(options as { idempotencyKey?: string });
  const result = await client(command, leaf)["cleanup.create"](
    {
      params: {},
      query: {},
      body: {
        kind: cleanable,
        instance_name: instanceName ?? null,
        rule,
        keys,
      },
    },
    { idempotencyKey: key },
  );
  write({
    ...handleMutationResult(result, code(leaf, "indeterminate"), key),
    idempotency_key: key,
  });
}

async function cleanupGet(cleanupId: string, command: Command): Promise<void> {
  const leaf = `${CLEANUP}.${GET}`;
  const result = await client(command, leaf)["cleanup.get"]({
    params: {
      cleanup_id: parsed(
        identitySchema(CLEANUP_IDENTITY_PREFIX),
        cleanupId,
        leaf,
        "cleanup_id",
      ),
    },
    query: {},
    body: null,
  });
  write(handleReadResult(result, code(leaf, "indeterminate")));
}

async function cleanupList(command: Command): Promise<void> {
  const leaf = `${CLEANUP}.${LIST}`;
  const options = command.optsWithGlobals<Options>();
  const result = await client(command, leaf)["cleanup.list"]({
    params: {},
    query: present({
      kind:
        options.kind === undefined
          ? undefined
          : parsed(z.enum(CleanableKind), options.kind, leaf, "kind"),
      limit: limitOf(options),
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  write(handleReadResult(result, code(leaf, "indeterminate")));
}

async function cleanupCancel(
  cleanupId: string,
  command: Command,
): Promise<void> {
  const leaf = `${CLEANUP}.${CANCEL}`;
  const options = command.optsWithGlobals<Options>();
  const key = resolveKey(options as { idempotencyKey?: string });
  const result = await client(command, leaf)["cleanup.cancel"](
    {
      params: {
        cleanup_id: parsed(
          identitySchema(CLEANUP_IDENTITY_PREFIX),
          cleanupId,
          leaf,
          "cleanup_id",
        ),
      },
      query: {},
      body: null,
    },
    { idempotencyKey: key },
  );
  write({
    ...handleMutationResult(result, code(leaf, "indeterminate"), key),
    idempotency_key: key,
  });
}

async function alertList(command: Command): Promise<void> {
  const leaf = `${ALERT}.${LIST}`;
  const options = command.optsWithGlobals<Options>();
  const result = await client(command, leaf)["alert.list"]({
    params: {},
    query: present({
      open: options.open === true ? ("true" as const) : undefined,
      limit: limitOf(options),
      cursor: options.cursor as string | undefined,
    }),
    body: null,
  });
  write(handleReadResult(result, code(leaf, "indeterminate")));
}

async function alertAcknowledge(
  alertId: string,
  command: Command,
): Promise<void> {
  const leaf = `${ALERT}.${ACKNOWLEDGE}`;
  const options = command.optsWithGlobals<Options>();
  const key = resolveKey(options as { idempotencyKey?: string });
  const result = await client(command, leaf)["alert.acknowledge"](
    {
      params: {
        alert_id: parsed(
          identitySchema(ALERT_IDENTITY_PREFIX),
          alertId,
          leaf,
          "alert_id",
        ),
      },
      query: {},
      body: null,
    },
    { idempotencyKey: key },
  );
  write({
    ...handleMutationResult(result, code(leaf, "indeterminate"), key),
    idempotency_key: key,
  });
}

async function measureRun(command: Command): Promise<void> {
  const leaf = `${MEASURE}.${RUN}`;
  const options = command.optsWithGlobals<Options>();
  const key = resolveKey(options as { idempotencyKey?: string });
  const result = await client(command, leaf)["measure.run"](
    { params: {}, query: {}, body: null },
    { idempotencyKey: key },
  );
  write(handleMutationResult(result, code(leaf, "indeterminate"), key));
}

function pageOptions(command: Command): Command {
  return command
    .option("--limit <count>", "Maximum results per page", singleUse("--limit"))
    .option(
      "--cursor <cursor>",
      "Continue from a cursor",
      singleUse("--cursor"),
    );
}

export function addFootprintCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  const footprint = program
    .command(CommandName.Footprint)
    .description("Footprint Service commands")
    .option("--endpoint <url>", "Server endpoint", singleUse("--endpoint"))
    .option(
      "--token <token>",
      "JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    );
  footprint.action(() => footprint.help());
  footprint
    .command(SUMMARY)
    .description("Print one line for each footprint kind, host and item")
    .action((_options, command: Command) => summary(command));
  const kind = footprint.command(KIND).description("Read footprint kinds");
  kind.action(() => kind.help());
  kind
    .command(GET)
    .description("Read the statistics of a kind as JSON")
    .argument("<kind>", "Footprint kind")
    .option("--instance <name>", "Worker instance", singleUse("--instance"))
    .action((value: string, _options, command: Command) =>
      kindGet(value, command),
    );
  const candidate = footprint
    .command(CANDIDATE)
    .description("Preview cleanup candidates");
  candidate.action(() => candidate.help());
  pageOptions(
    candidate
      .command(LIST)
      .description("List the candidates of a rule as JSON")
      .argument("<kind>", "Cleanable kind")
      .option("--instance <name>", "Worker instance", singleUse("--instance"))
      .option("--rule <rule>", "Cleanup rule", singleUse("--rule"))
      .option(
        "--older-than-days <n>",
        "Age of the older_than rule",
        singleUse("--older-than-days"),
      ),
  ).action((value: string, _options, command: Command) =>
    candidateList(value, command),
  );
  const item = footprint.command(ITEM).description("Read footprint items");
  item.action(() => item.help());
  pageOptions(
    item
      .command(LIST)
      .description("List every item of a kind as JSON, oldest first")
      .argument("<kind>", "Cleanable kind")
      .option("--instance <name>", "Worker instance", singleUse("--instance")),
  ).action((value: string, _options, command: Command) =>
    itemList(value, command),
  );
  const cleanup = footprint.command(CLEANUP).description("Cleanup commands");
  cleanup.action(() => cleanup.help());
  const create = cleanup
    .command(CREATE)
    .description("Request the cleanup of the confirmed keys")
    .argument("<kind>", "Cleanable kind")
    .option("--instance <name>", "Worker instance", singleUse("--instance"))
    .option("--rule <rule>", "Cleanup rule", singleUse("--rule"))
    .option(
      "--older-than-days <n>",
      "Age of the older_than rule",
      singleUse("--older-than-days"),
    )
    .option("--file <path>", "JSON list of keys", singleUse("--file"))
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((value: string, _options, command: Command) =>
      cleanupCreate(value, command),
    );
  addFileBodyHelp(create, {
    schema: cleanupCreateSchema.shape.keys,
    example: ["0123456789abcdef0123456789abcdef"],
  });
  cleanup
    .command(GET)
    .description("Read a cleanup record as JSON")
    .argument("<cleanup-id>", "Cleanup identity")
    .action((value: string, _options, command: Command) =>
      cleanupGet(value, command),
    );
  pageOptions(
    cleanup
      .command(LIST)
      .description("List cleanup records as JSON, newest first")
      .option("--kind <kind>", "Cleanable kind", singleUse("--kind")),
  ).action((_options, command: Command) => cleanupList(command));
  cleanup
    .command(CANCEL)
    .description("Cancel a queued cleanup")
    .argument("<cleanup-id>", "Cleanup identity")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((value: string, _options, command: Command) =>
      cleanupCancel(value, command),
    );
  const alert = footprint.command(ALERT).description("Alert commands");
  alert.action(() => alert.help());
  pageOptions(
    alert
      .command(LIST)
      .description("List alert episodes as JSON, newest first")
      .option("--open", "Only open episodes"),
  ).action((_options, command: Command) => alertList(command));
  alert
    .command(ACKNOWLEDGE)
    .description("Acknowledge an open alert episode")
    .argument("<alert-id>", "Alert identity")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((value: string, _options, command: Command) =>
      alertAcknowledge(value, command),
    );
  const measure = footprint.command(MEASURE).description("Measure commands");
  measure.action(() => measure.help());
  measure
    .command(RUN)
    .description("Measure the server kinds at once")
    .option("--idempotency-key <key>", "Mutation key", singleUse(KEY_OPTION))
    .action((_options, command: Command) => measureRun(command));
}

import { z } from "zod";
import { humanActorSchema } from "../kernel/actor.ts";
import {
  CLEANUP_BATCH_ROWS,
  CleanupRefusal,
  cleanupRefusedSchema,
  FOOTPRINT_SERVICE,
} from "../kernel/cleanup.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  ALERT_IDENTITY_PREFIX,
  CLEANUP_IDENTITY_PREFIX,
  identitySchema,
} from "../kernel/identity.ts";
import {
  AccessPolicy,
  type Operation,
  OperationLifetime,
  StoreName,
} from "../kernel/operation.ts";
import { DEFAULT_AGE_DAYS } from "../tracking/contract.ts";
import { instanceNameSchema } from "../worker/contract.ts";

export { CleanupRefusal, DEFAULT_AGE_DAYS };

export const FOOTPRINT_SERVICE_NAME = FOOTPRINT_SERVICE;
export const FOOTPRINT_TIMEOUT_MS = 30000;
export const FOOTPRINT_MEASURE_INTERVAL_MS = 900000;
export const FOOTPRINT_STALE_INTERVALS = 3;
export const FOOTPRINT_ALERT_CONFIRMATIONS = 2;
export const FOOTPRINT_ALERT_CLEAR_RATIO = 0.9;
export const FOOTPRINT_CLEANUP_BATCH_ROWS = CLEANUP_BATCH_ROWS;
export const FOOTPRINT_CLEANUP_KEYS_MAX = 1000;
export const FOOTPRINT_REPORT_ITEMS_MAX = 10000;
export const FOOTPRINT_SCAN_BUDGET_MS = 500;
export const FOOTPRINT_KEY_MAX_LENGTH = 512;
export const FOOTPRINT_LIST_LIMIT_DEFAULT = 100;
export const FOOTPRINT_LIST_LIMIT_MAX = 1000;
export const OLDER_THAN_DAYS_MAX = 3650;
export const DAY_MS = 86400000;
export const RUNTIME_STORE_DEVICE = "container_runtime";

export const FootprintKind = {
  OperationalDatabase: "operational_database",
  Trace: "trace",
  DatabaseBackup: "database_backup",
  Log: "log",
  Environment: "environment",
  CacheVolume: "cache_volume",
  SlotImage: "slot_image",
  SlotResidue: "slot_residue",
  IntakeMirror: "intake_mirror",
  Workbench: "workbench",
  Session: "session",
  Workspace: "workspace",
  ToolOutput: "tool_output",
  Disk: "disk",
} as const;
export type FootprintKind = (typeof FootprintKind)[keyof typeof FootprintKind];

export const CleanableKind = {
  Trace: FootprintKind.Trace,
  DatabaseBackup: FootprintKind.DatabaseBackup,
  Environment: FootprintKind.Environment,
  CacheVolume: FootprintKind.CacheVolume,
  SlotImage: FootprintKind.SlotImage,
  Session: FootprintKind.Session,
  Workspace: FootprintKind.Workspace,
  ToolOutput: FootprintKind.ToolOutput,
} as const;
export type CleanableKind = (typeof CleanableKind)[keyof typeof CleanableKind];

export const InstanceFootprintKind = {
  Session: FootprintKind.Session,
  Workspace: FootprintKind.Workspace,
  ToolOutput: FootprintKind.ToolOutput,
  Log: FootprintKind.Log,
  SlotResidue: FootprintKind.SlotResidue,
} as const;
export type InstanceFootprintKind =
  (typeof InstanceFootprintKind)[keyof typeof InstanceFootprintKind];

export const InstanceCleanableKind = {
  Session: FootprintKind.Session,
  Workspace: FootprintKind.Workspace,
  ToolOutput: FootprintKind.ToolOutput,
} as const;
export type InstanceCleanableKind =
  (typeof InstanceCleanableKind)[keyof typeof InstanceCleanableKind];

export const CleanupRule = {
  OlderThan: "older_than",
  NodeClosed: "node_closed",
  Unbound: "unbound",
  Superseded: "superseded",
  Dangling: "dangling",
} as const;
export type CleanupRule = (typeof CleanupRule)[keyof typeof CleanupRule];

export const CleanupState = {
  Queued: "queued",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type CleanupState = (typeof CleanupState)[keyof typeof CleanupState];

export const FootprintAlertState = {
  Ok: "ok",
  Pending: "pending",
  Firing: "firing",
  Recovering: "recovering",
} as const;
export type FootprintAlertState =
  (typeof FootprintAlertState)[keyof typeof FootprintAlertState];

export const ThresholdMeasure = {
  Bytes: "bytes",
  FreeRatio: "free_ratio",
  DaysToFloor: "days_to_floor",
} as const;
export type ThresholdMeasure =
  (typeof ThresholdMeasure)[keyof typeof ThresholdMeasure];

export const FootprintErrorCode = {
  InstanceNotFound: "footprint.instance.not_found",
  InstanceArchived: "footprint.instance.archived",
  HostMismatch: "footprint.kind.host_mismatch",
  RuleNotSupported: "footprint.rule.not_supported",
  CleanupNotFound: "footprint.cleanup.not_found",
  CleanupNotQueued: "footprint.cleanup.not_queued",
  AlertNotFound: "footprint.alert.not_found",
  AlertResolved: "footprint.alert.resolved",
  AlertAcknowledged: "footprint.alert.acknowledged",
  CursorInvalid: "system.pagination.cursor_invalid",
  ValidationFailed: "gateway.request.validation_failed",
} as const;

export const SERVER_KINDS: readonly FootprintKind[] = [
  FootprintKind.OperationalDatabase,
  FootprintKind.Trace,
  FootprintKind.DatabaseBackup,
  FootprintKind.Environment,
  FootprintKind.CacheVolume,
  FootprintKind.SlotImage,
  FootprintKind.IntakeMirror,
  FootprintKind.Workbench,
];

export const KIND_RULES: Readonly<
  Record<CleanableKind, readonly CleanupRule[]>
> = {
  [CleanableKind.Trace]: [CleanupRule.OlderThan],
  [CleanableKind.DatabaseBackup]: [CleanupRule.OlderThan],
  [CleanableKind.Environment]: [CleanupRule.Unbound, CleanupRule.Superseded],
  [CleanableKind.CacheVolume]: [CleanupRule.Unbound],
  [CleanableKind.SlotImage]: [CleanupRule.Superseded],
  [CleanableKind.Session]: [CleanupRule.OlderThan],
  [CleanableKind.Workspace]: [CleanupRule.NodeClosed],
  [CleanableKind.ToolOutput]: [CleanupRule.OlderThan],
};

export const DELETE_OPERATIONS: Readonly<Record<CleanableKind, string>> = {
  [CleanableKind.Trace]: "tracking.trace.delete",
  [CleanableKind.DatabaseBackup]: "footprint.backup.delete",
  [CleanableKind.Environment]: "project.environment.delete",
  [CleanableKind.CacheVolume]: "project.environment.cache_volume.delete",
  [CleanableKind.SlotImage]: "worker.slot_image.delete",
  [CleanableKind.Session]: "worker.instance.session.delete",
  [CleanableKind.Workspace]: "worker.instance.workspace.delete",
  [CleanableKind.ToolOutput]: "worker.instance.tool_output.delete",
};

export const footprintTimeSchema = z.int().min(0);

export const footprintThresholdSchema = z.discriminatedUnion("measure", [
  z.strictObject({
    measure: z.literal(ThresholdMeasure.Bytes),
    value: z.int().min(1),
  }),
  z.strictObject({
    measure: z.literal(ThresholdMeasure.FreeRatio),
    value: z.number().gt(0).lt(1),
  }),
  z.strictObject({
    measure: z.literal(ThresholdMeasure.DaysToFloor),
    value: z.int().min(1),
    free_ratio: z.number().gt(0).lt(1),
  }),
]);
export type FootprintThreshold = z.infer<typeof footprintThresholdSchema>;

export const cleanupRuleSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal(CleanupRule.OlderThan),
    older_than_days: z.int().min(1).max(OLDER_THAN_DAYS_MAX),
  }),
  z.strictObject({ name: z.literal(CleanupRule.NodeClosed) }),
  z.strictObject({ name: z.literal(CleanupRule.Unbound) }),
  z.strictObject({ name: z.literal(CleanupRule.Superseded) }),
  z.strictObject({ name: z.literal(CleanupRule.Dangling) }),
]);
export type CleanupRuleValue = z.infer<typeof cleanupRuleSchema>;

const measureErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
});
export type MeasureError = z.infer<typeof measureErrorSchema>;

export const footprintStatSchema = z.strictObject({
  kind: z.enum(FootprintKind),
  instance_name: instanceNameSchema.nullable(),
  item_key: z.string().min(1).nullable(),
  instance_names: z.array(instanceNameSchema),
  measured_at: footprintTimeSchema.nullable(),
  stale: z.boolean(),
  measure_error: measureErrorSchema.nullable(),
  count: z.int().min(0).nullable(),
  bytes: z.int().min(0).nullable(),
  wal_bytes: z.int().min(0).nullable(),
  free_bytes: z.int().min(0).nullable(),
  total_bytes: z.int().min(0).nullable(),
  oldest_at: footprintTimeSchema.nullable(),
  newest_at: footprintTimeSchema.nullable(),
  growth_per_day: z
    .strictObject({ count: z.number().min(0), bytes: z.number().min(0) })
    .nullable(),
  days_to_floor: z.number().min(0).nullable(),
  thresholds: z.array(footprintThresholdSchema),
  alert: z.strictObject({
    state: z.enum(FootprintAlertState),
    alert_id: identitySchema(ALERT_IDENTITY_PREFIX).nullable(),
  }),
  delete_operation: z.string().min(1).nullable(),
  rules: z.array(z.enum(CleanupRule)),
  candidates: z
    .strictObject({
      rule: cleanupRuleSchema,
      count: z.int().min(0),
      bytes: z.int().min(0).nullable(),
      bytes_estimated: z.boolean(),
    })
    .nullable(),
});
export type FootprintStat = z.infer<typeof footprintStatSchema>;

export const footprintTableSchema = z.strictObject({
  name: z.string().min(1),
  bytes: z.int().min(0).nullable(),
  oldest_at: footprintTimeSchema.nullable(),
  delete_operation: z.string().min(1).nullable(),
});
export type FootprintTable = z.infer<typeof footprintTableSchema>;

export const footprintCandidateSchema = z.strictObject({
  key: z.string().min(1).max(FOOTPRINT_KEY_MAX_LENGTH),
  at: footprintTimeSchema,
  bytes: z.int().min(0).nullable(),
  project_id: identitySchema("project").nullable(),
  node_id: identitySchema("node").nullable(),
  execution_id: identitySchema("execution").nullable(),
  refusal: z.enum(CleanupRefusal).nullable(),
  kept: z.boolean(),
});
export type FootprintCandidate = z.infer<typeof footprintCandidateSchema>;

const traceKeySchema = z.string().regex(/^[0-9a-f]{32}$/);
export const BACKUP_NAME_PATTERN =
  /^(kanthord\.db|tracking\.db|[A-Za-z0-9._-]+\.yaml)\.bak-\d{8}T\d{6}$/;
const backupKeySchema = z.string().regex(BACKUP_NAME_PATTERN);
const environmentKeySchema = z
  .string()
  .regex(/^(?:[a-z0-9][a-z0-9/-]*@[0-9a-f]{64}|sha256:[0-9a-f]{64})$/);
const cacheVolumeKeySchema = z.string().regex(/^kanthord_cache_[0-9a-z]{24}$/);
const slotImageKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/);
const executionKeySchema = identitySchema("execution");
const workspaceKeySchema = z
  .string()
  .regex(/^(?:node|execution)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const TOOL_OUTPUT_NAME_PATTERN =
  /^pi-[a-z0-9-]+-[0-9a-f]{16}(\.[A-Za-z0-9]+)?$/;
const toolOutputKeySchema = z.string().regex(TOOL_OUTPUT_NAME_PATTERN);

const KEY_SCHEMAS: Readonly<Record<CleanableKind, z.ZodType<string>>> = {
  [CleanableKind.Trace]: traceKeySchema,
  [CleanableKind.DatabaseBackup]: backupKeySchema,
  [CleanableKind.Environment]: environmentKeySchema,
  [CleanableKind.CacheVolume]: cacheVolumeKeySchema,
  [CleanableKind.SlotImage]: slotImageKeySchema,
  [CleanableKind.Session]: executionKeySchema,
  [CleanableKind.Workspace]: workspaceKeySchema,
  [CleanableKind.ToolOutput]: toolOutputKeySchema,
};

export function footprintKeySchema(kind: CleanableKind): z.ZodType<string> {
  return KEY_SCHEMAS[kind];
}

export const cleanupCreateSchema = z.strictObject({
  kind: z.enum(CleanableKind),
  instance_name: instanceNameSchema.nullable(),
  rule: cleanupRuleSchema.nullable(),
  keys: z
    .array(z.string().min(1).max(FOOTPRINT_KEY_MAX_LENGTH))
    .min(1)
    .max(FOOTPRINT_CLEANUP_KEYS_MAX),
});
export type CleanupCreate = z.infer<typeof cleanupCreateSchema>;

export const cleanupOutcomeSchema = z.strictObject({
  removed: z.int().min(0),
  removed_bytes: z.int().min(0).nullable(),
  absent: z.int().min(0),
  refused: z.array(cleanupRefusedSchema),
});
export type CleanupOutcome = z.infer<typeof cleanupOutcomeSchema>;

export const cleanupRecordSchema = z.strictObject({
  cleanup_id: identitySchema(CLEANUP_IDENTITY_PREFIX),
  kind: z.enum(CleanableKind),
  instance_name: instanceNameSchema.nullable(),
  rule: cleanupRuleSchema.nullable(),
  keys: z.array(z.string()),
  requested_by: humanActorSchema,
  requested_at: footprintTimeSchema,
  state: z.enum(CleanupState),
  finished_at: footprintTimeSchema.nullable(),
  outcome: cleanupOutcomeSchema.extend({ pending: z.int().min(0) }).nullable(),
});
export type CleanupRecord = z.infer<typeof cleanupRecordSchema>;

export const footprintAlertSchema = z.strictObject({
  alert_id: identitySchema(ALERT_IDENTITY_PREFIX),
  kind: z.enum(FootprintKind),
  instance_name: instanceNameSchema.nullable(),
  item_key: z.string().min(1).nullable(),
  threshold: footprintThresholdSchema,
  value: z.number().min(0),
  fired_at: footprintTimeSchema,
  resolved_at: footprintTimeSchema.nullable(),
  acknowledged_by: humanActorSchema.nullable(),
  acknowledged_at: footprintTimeSchema.nullable(),
  acknowledged_until: z.int().min(0).nullable(),
  state: z.enum(FootprintAlertState),
});
export type FootprintAlert = z.infer<typeof footprintAlertSchema>;

export const backupDeleteSchema = z.strictObject({
  names: z.array(backupKeySchema).min(1).max(FOOTPRINT_CLEANUP_BATCH_ROWS),
});

export interface FootprintMeasure {
  readonly kind: FootprintKind;
  readonly instance_name: string | null;
  readonly item_key: string | null;
  readonly instance_names: readonly string[];
  readonly device: string | null;
  readonly runtime_store: boolean;
  readonly measure_error: MeasureError | null;
  readonly count: number | null;
  readonly bytes: number | null;
  readonly wal_bytes: number | null;
  readonly free_bytes: number | null;
  readonly total_bytes: number | null;
  readonly oldest_at: number | null;
  readonly newest_at: number | null;
  readonly recent_count: number | null;
}

export interface CandidateQuery {
  readonly kind: CleanableKind;
  readonly instance_name: string | null;
  readonly rule: CleanupRuleValue | null;
  readonly offset: number;
  readonly limit: number;
  readonly now: number;
  readonly signal: AbortSignal;
}

export interface CandidatePage {
  readonly items: readonly FootprintCandidate[];
  readonly total_count: number;
  readonly total_bytes: number | null;
}

export interface FootprintOwner {
  readonly kinds: readonly FootprintKind[];
  measure(signal: AbortSignal): Promise<readonly FootprintMeasure[]>;
  candidates(query: CandidateQuery): Promise<CandidatePage>;
  tables?(
    kind: FootprintKind,
    signal: AbortSignal,
  ): Promise<readonly FootprintTable[] | null>;
}

export function emptyMeasure(
  kind: FootprintKind,
  fields: Partial<FootprintMeasure> = {},
): FootprintMeasure {
  return {
    kind,
    instance_name: null,
    item_key: null,
    instance_names: [],
    device: null,
    runtime_store: false,
    measure_error: null,
    count: null,
    bytes: null,
    wal_bytes: null,
    free_bytes: null,
    total_bytes: null,
    oldest_at: null,
    newest_at: null,
    recent_count: null,
    ...fields,
  };
}

export interface MeasuredItem {
  readonly bytes: number;
  readonly at: number;
}

export function itemsMeasure(
  kind: FootprintKind,
  items: readonly MeasuredItem[],
  now: number,
  fields: Partial<FootprintMeasure> = {},
): FootprintMeasure {
  const since = now - DEFAULT_AGE_DAYS * DAY_MS;
  const times = items.map((item) => item.at);
  return emptyMeasure(kind, {
    ...fields,
    count: items.length,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    oldest_at: times.length ? Math.min(...times) : null,
    newest_at: times.length ? Math.max(...times) : null,
    recent_count: times.filter((at) => at >= since).length,
  });
}

export function failedMeasure(
  kind: FootprintKind,
  code: string,
  message: string,
  fields: Partial<FootprintMeasure> = {},
): FootprintMeasure {
  return emptyMeasure(kind, { ...fields, measure_error: { code, message } });
}

export function olderThanCutoff(
  rule: CleanupRuleValue | null,
  now: number,
): number | null {
  return rule?.name === CleanupRule.OlderThan
    ? now - rule.older_than_days * DAY_MS
    : null;
}

const emptyFields = z.strictObject({});
const kindParams = z.strictObject({ kind: z.enum(FootprintKind) });
const cleanableParams = z.strictObject({ kind: z.enum(CleanableKind) });
const cleanupParams = z.strictObject({
  cleanup_id: identitySchema(CLEANUP_IDENTITY_PREFIX),
});
const alertParams = z.strictObject({
  alert_id: identitySchema(ALERT_IDENTITY_PREFIX),
});
const limitField = z.coerce
  .number()
  .int()
  .min(1)
  .max(FOOTPRINT_LIST_LIMIT_MAX)
  .default(FOOTPRINT_LIST_LIMIT_DEFAULT);
const cursorField = z.string().min(1).optional();
const footprintOperation = {
  service: FOOTPRINT_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: FOOTPRINT_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
const footprintRead = {
  ...footprintOperation,
  method: HttpMethod.Get,
  mutation: false,
  body: false,
} as const;
const footprintMutation = {
  ...footprintOperation,
  method: HttpMethod.Post,
  mutation: true,
  body: true,
} as const;
const statsAnswer = z.strictObject({ stats: z.array(footprintStatSchema) });

export const footprintOperations = {
  "summary.get": {
    ...footprintRead,
    id: "footprint.summary.get",
    path: "/api/footprint",
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: z.null(),
    }),
    output: statsAnswer.extend({
      open_alerts: z.int().min(0),
      unacknowledged_alerts: z.int().min(0),
    }),
    description:
      "Read the statistics of every footprint kind, host and item, with the count of open and unacknowledged alert episodes.",
  },
  "kind.get": {
    ...footprintRead,
    id: "footprint.kind.get",
    path: "/api/footprint/kind/:kind",
    input: z.strictObject({
      params: kindParams,
      query: z.strictObject({ instance_name: instanceNameSchema.optional() }),
      body: z.null(),
    }),
    output: statsAnswer.extend({
      tables: z.array(footprintTableSchema).nullable(),
    }),
    description:
      "Read the statistics of one footprint kind for each host, with the table breakdown of trace and operational_database.",
  },
  "candidate.list": {
    ...footprintRead,
    id: "footprint.candidate.list",
    path: "/api/footprint/kind/:kind/candidate",
    input: z.strictObject({
      params: cleanableParams,
      query: z.strictObject({
        instance_name: instanceNameSchema.optional(),
        rule: z.enum(CleanupRule).optional(),
        older_than_days: z.coerce
          .number()
          .int()
          .min(1)
          .max(OLDER_THAN_DAYS_MAX)
          .optional(),
        limit: limitField,
        cursor: cursorField,
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(footprintCandidateSchema),
      next_cursor: z.string().nullable(),
      total_count: z.int().min(0),
      total_bytes: z.int().min(0).nullable(),
      bytes_estimated: z.boolean(),
    }),
    description:
      "Page the cleanup candidates of a rule for one cleanable kind and host, with the totals of the whole set. A rule only proposes.",
  },
  "item.list": {
    ...footprintRead,
    id: "footprint.item.list",
    path: "/api/footprint/kind/:kind/item",
    input: z.strictObject({
      params: cleanableParams,
      query: z.strictObject({
        instance_name: instanceNameSchema.optional(),
        limit: limitField,
        cursor: cursorField,
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(footprintCandidateSchema),
      next_cursor: z.string().nullable(),
    }),
    description:
      "Page every item of one cleanable kind and host, oldest first, with the live refusal and the kept mark of each item.",
  },
  "cleanup.create": {
    ...footprintMutation,
    id: "footprint.cleanup.create",
    path: "/api/footprint/cleanup",
    status: HttpStatus.Created,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: cleanupCreateSchema,
    }),
    output: cleanupRecordSchema,
    description:
      "Record a cleanup of the keys that the human confirms, as queued. A background task calls the delete operation of the owner of the kind.",
  },
  "cleanup.get": {
    ...footprintRead,
    id: "footprint.cleanup.get",
    path: "/api/footprint/cleanup/:cleanup_id",
    input: z.strictObject({
      params: cleanupParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: cleanupRecordSchema,
    description: "Read one cleanup record with its outcome.",
  },
  "cleanup.list": {
    ...footprintRead,
    id: "footprint.cleanup.list",
    path: "/api/footprint/cleanup",
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({
        kind: z.enum(CleanableKind).optional(),
        limit: limitField,
        cursor: cursorField,
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(cleanupRecordSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "Page the cleanup records, newest first.",
  },
  "cleanup.cancel": {
    ...footprintMutation,
    id: "footprint.cleanup.cancel",
    path: "/api/footprint/cleanup/:cleanup_id/cancel",
    body: false,
    input: z.strictObject({
      params: cleanupParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: cleanupRecordSchema,
    description: "Cancel a queued cleanup. A running cleanup refuses.",
  },
  "alert.list": {
    ...footprintRead,
    id: "footprint.alert.list",
    path: "/api/footprint/alert",
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({
        open: z.enum(["true", "false"]).optional(),
        limit: limitField,
        cursor: cursorField,
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(footprintAlertSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "Page the footprint alert episodes, newest first.",
  },
  "alert.acknowledge": {
    ...footprintMutation,
    id: "footprint.alert.acknowledge",
    path: "/api/footprint/alert/:alert_id/acknowledge",
    body: false,
    input: z.strictObject({
      params: alertParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: footprintAlertSchema,
    description:
      "Acknowledge an open alert episode. The acknowledgement hides the episode from the banner and the badge until it ends.",
  },
  "measure.run": {
    ...footprintMutation,
    id: "footprint.measure.run",
    path: "/api/footprint/measure",
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: z.null(),
    }),
    output: statsAnswer,
    description:
      "Measure the server kinds at once and answer their statistics.",
  },
  "backup.delete": {
    ...footprintMutation,
    id: "footprint.backup.delete",
    path: "/api/footprint/backup/delete",
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: backupDeleteSchema,
    }),
    output: z.strictObject({
      removed: z.int().min(0),
      absent: z.int().min(0),
    }),
    description:
      "Delete database backup files by name. A name outside the backup form refuses.",
  },
} as const satisfies Record<string, Operation>;

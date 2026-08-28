import { z } from "zod";
import type { ZodType } from "zod";

import { objectId } from "../../domain/column.ts";
import type { EventType } from "../../domain/event-type.ts";
import { gitIntents } from "../../domain/git-operation.ts";
import { differingFields } from "../../domain/node-write-legality.ts";
import { taskReportOutcomes } from "../../domain/outcome-report.ts";
import { choices } from "../../domain/plan-choice.ts";
import { providerKinds } from "../../domain/provider-payload.ts";
import { readinessReasons } from "../../domain/readiness.ts";
import { credentialFailures } from "../../domain/repository.ts";
import {
  leaseSweepTargets,
  leaseVerdictTargets,
  reapFindings,
  reconcileVerdicts,
  remnantClasses,
  remnantRefusalReasons,
} from "../../domain/recovery.ts";
import { runningReasons } from "../../domain/run.ts";
import {
  blockReasons,
  nodeKinds,
  nodeStates,
  terminalStates,
} from "../../domain/state.ts";

const fence = z.number().int();
const nodeState = z.enum(nodeStates);
const terminalState = z.enum(terminalStates);
const nodeKind = z.enum(nodeKinds);
const providerKind = z.enum(providerKinds);
const gitIntent = z.enum(gitIntents);
const importId = z.string().nullable();

const closePayload = z.strictObject({
  from: nodeState,
  to: nodeState,
  reason: z.literal("human-close"),
  objectId,
  objectiveRunId: z.string(),
  acknowledgePartial: z.boolean(),
});

const rollUpPayload = z.strictObject({
  from: nodeState,
  to: nodeState,
  reason: z.literal("objectives-terminal"),
  objectiveStates: z.array(terminalState),
});

const verdictPayload = z.strictObject({
  target: z.enum(leaseVerdictTargets),
  clean: z.boolean(),
  headOid: objectId.nullable(),
  baseOid: objectId.nullable(),
  fence,
});

const sweepPayload = z.strictObject({
  target: z.enum(leaseSweepTargets),
  clean: z.literal(false),
  headOid: objectId.nullable(),
  baseOid: objectId.nullable(),
  fence,
  driver: z.literal("external"),
  runId: z.string().nullable(),
});

export const eventPayloads: Readonly<Record<EventType, ZodType>> = {
  "actor.registered": z.strictObject({
    actorId: z.string(),
    kind: z.literal("harness"),
    name: z.string(),
    registeredBy: z.string(),
  }),
  "actor.revoked": z.strictObject({
    actorId: z.string(),
    kind: z.literal("harness"),
    name: z.string(),
    revokedBy: z.string(),
    revokedAt: z.number().int(),
    leasesFenced: z.number().int(),
  }),
  "actor.tokenRotated": z.strictObject({
    actorId: z.string(),
    kind: z.literal("harness"),
    name: z.string(),
    rotatedBy: z.string(),
    rotatedAt: z.number().int(),
  }),
  "lease.claimed": z.strictObject({
    subjectId: z.string(),
    objectiveId: z.string(),
    fence,
    objectiveFence: fence,
    expiresAt: z.number().int(),
    runId: z.string(),
    objectiveRunId: z.string(),
    attemptId: z.string().nullable(),
    attemptNo: z.number().int().nullable(),
  }),
  "lease.released": z.strictObject({
    subjectId: z.string(),
    objectiveId: z.string(),
    fence,
  }),
  "lease.renewed": z.strictObject({
    subjectId: z.string(),
    objectiveId: z.string(),
    fence,
    objectiveFence: fence,
    expiresAt: z.number().int(),
    objectiveExpiresAt: z.number().int(),
  }),
  "node.awaitingApproval": z.strictObject({
    from: nodeState,
    to: nodeState,
    reason: z.literal("object-attested"),
    objectId,
    projection: terminalState,
    objectiveRunId: z.string(),
  }),
  "node.created": z.strictObject({
    kind: nodeKind,
    parentId: z.string().nullable(),
    revision: z.string(),
  }),
  "node.deleted": z.strictObject({
    kind: nodeKind,
    parentId: z.string().nullable(),
    revision: z.string(),
  }),
  "node.discarded": rollUpPayload,
  "node.done": z.union([closePayload, rollUpPayload]),
  "node.imported": z.strictObject({
    revision: z.string(),
    source: z.enum(choices),
  }),
  "node.partial": z.union([closePayload, rollUpPayload]),
  "node.pending": z.strictObject({
    from: nodeState,
    to: nodeState,
    reason: z.enum(readinessReasons),
    revision: z.string(),
    importId,
  }),
  "node.ready": z.strictObject({
    from: nodeState,
    to: nodeState,
    reason: z.enum(readinessReasons),
    revision: z.string(),
    importId,
  }),
  "node.running": z.strictObject({
    from: z.literal("ready"),
    to: z.literal("running"),
    reason: z.enum(runningReasons),
    revision: z.string(),
    importId,
  }),
  "node.unblocked": z.strictObject({
    from: z.literal("blocked"),
    to: z.literal("pending"),
    clearedReason: z.enum(blockReasons),
  }),
  "node.updated": z.strictObject({
    fields: z.array(z.enum(differingFields)),
    revision: z.string(),
  }),
  "outcome.reported": z.strictObject({
    runId: z.string(),
    attemptId: z.string(),
    attemptNo: z.number().int(),
    outcome: z.enum(taskReportOutcomes),
    reason: z.string().nullable(),
    objectId: objectId.nullable(),
    attemptsRemaining: z.number().int(),
    fromState: z.enum(nodeStates),
    toState: z.enum(nodeStates),
  }),
  "plan.imported": z.strictObject({
    revision: z.string(),
    importId: z.string(),
    nodes: z.number().int(),
    absent: z.array(z.string()),
  }),
  "project.created": z.strictObject({
    name: z.string(),
  }),
  "project.repositoriesReplaced": z.strictObject({
    repositories: z.array(z.string()),
  }),
  "provider.defaultSet": z.strictObject({
    name: z.string(),
    kind: providerKind,
    setDefaultAt: z.number().int(),
  }),
  "provider.defaultUnset": z.strictObject({
    name: z.string(),
    kind: providerKind,
    unsetAt: z.number().int(),
  }),
  "provider.registered": z.strictObject({
    name: z.string(),
    kind: providerKind,
  }),
  "provider.removed": z.strictObject({
    name: z.string(),
    kind: providerKind,
  }),
  "provider.renamed": z.strictObject({
    from: z.string(),
    to: z.string(),
  }),
  "recovery.childReaped": z.strictObject({
    gitOperationId: z.string().nullable(),
    pidFile: z.string(),
    finding: z.enum(reapFindings),
  }),
  "recovery.journalReconciled": z.strictObject({
    gitOperationId: z.string(),
    intent: gitIntent,
    ref: z.string(),
    observed: objectId.nullable(),
    verdict: z.enum(reconcileVerdicts),
  }),
  "recovery.leaseBlocked": verdictPayload,
  "recovery.leaseRecovered": z.union([sweepPayload, verdictPayload]),
  "recovery.publishReconcilePending": z.strictObject({
    gitOperationId: z.string(),
    ref: z.string(),
    proposedHeadOid: objectId,
  }),
  "recovery.remnantRefused": z.strictObject({
    path: z.string(),
    class: z.enum(remnantClasses),
    reason: z.enum(remnantRefusalReasons),
  }),
  "recovery.remnantRemoved": z.strictObject({
    path: z.string(),
    class: z.enum(remnantClasses),
  }),
  "repository.outsideWriter": z.strictObject({
    ref: z.string(),
    intent: gitIntent,
    expectedOid: objectId.nullable(),
    observedOid: objectId.nullable(),
  }),
  "repository.register.credentialRejected": z.strictObject({
    failure: z.enum(credentialFailures),
    name: z.string(),
    publishRef: z.string(),
    credentialId: z.string(),
  }),
  "repository.registered": z.strictObject({
    name: z.string(),
    branch: z.string(),
    publishOnApproval: z.boolean(),
    credentialId: z.string(),
    fetchedUpstreamOid: objectId,
    landingOid: objectId,
  }),
};

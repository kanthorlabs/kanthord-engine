import { agentOperations, GuardClass } from "../agent/contract.ts";
import { footprintOperations } from "../footprint/contract.ts";
import {
  intakeCredentialOperations,
  intakeOperations,
} from "../intake/contract.ts";
import type { Operation } from "../kernel/operation.ts";
import { isObject } from "../kernel/values.ts";
import { llmOperations } from "../llm/contract.ts";
import { ImportFormat, missionOperations } from "../mission/contract.ts";
import {
  environmentSecretOperations,
  projectOperations,
} from "../project/contract.ts";
import { repositoryOperations } from "../repository/contract.ts";
import { storageOperations } from "../storage/contract.ts";
import { trackingOperations } from "../tracking/contract.ts";
import { workerOperations } from "../worker/contract.ts";
import {
  GuardCause,
  type GuardInfo,
  WORKBENCH_IMPORT_FORMAT_TEXT,
  WORKBENCH_IMPORT_RETIREMENT_TEXT,
  WORKBENCH_REJECTION_REASON,
  workbenchHumanOnlyText,
  workbenchOperations,
} from "./contract.ts";
import {
  ClassifyKind,
  type ClassifyResult,
  decide,
  type GuardCall,
  guardRequest,
  type GuardRequest,
  GuardTier,
} from "./guard-classifier.ts";

export const HUMAN_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  missionOperations["node.discard"].id,
  missionOperations["node.override"].id,
  missionOperations["node.retire"].id,
  missionOperations["node.rebind"].id,
  missionOperations["node.ready"].id,
  missionOperations["evidence.delete"].id,
  missionOperations["evidence.asset.delete"].id,
  intakeOperations["storage.delete"].id,
  intakeOperations["inbound.create"].id,
  intakeOperations["inbound.delete"].id,
  intakeOperations["outbound.request.discard"].id,
  intakeOperations["outbound.request.delete"].id,
  intakeOperations["inbound.event.discard"].id,
  intakeOperations["inbound.event.delete"].id,
  intakeOperations["inbound.event.retry"].id,
  projectOperations["bindingSet.write"].id,
  projectOperations.create.id,
  projectOperations.rename.id,
  llmOperations.archive.id,
  llmOperations.revoke.id,
  llmOperations.update_metadata.id,
  llmOperations.login.id,
  repositoryOperations.archive.id,
  repositoryOperations.revoke.id,
  repositoryOperations.update_metadata.id,
  storageOperations.archive.id,
  storageOperations.revoke.id,
  storageOperations.update_metadata.id,
  agentOperations["enablement.put"].id,
  agentOperations["enablement.enable"].id,
  agentOperations["enablement.disable"].id,
  agentOperations["enablement.remove"].id,
  agentOperations["enablement.provider.add"].id,
  agentOperations["enablement.provider.remove"].id,
  workerOperations["registration.resume"].id,
  workerOperations["instance.archive"].id,
  workbenchOperations["session.approve"].id,
  workbenchOperations["session.message"].id,
  workbenchOperations["session.create"].id,
  workbenchOperations["session.configure"].id,
  workbenchOperations["session.fork"].id,
  workbenchOperations["session.abort"].id,
  workbenchOperations["session.queue.remove"].id,
  workbenchOperations["session.action.report"].id,
  workbenchOperations["session.autoMode.set"].id,
  workbenchOperations["invite.revoke"].id,
  footprintOperations["alert.acknowledge"].id,
  footprintOperations["backup.delete"].id,
  footprintOperations["cleanup.cancel"].id,
  footprintOperations["cleanup.create"].id,
  footprintOperations["measure.run"].id,
  intakeCredentialOperations.archive.id,
  intakeCredentialOperations.create.id,
  intakeCredentialOperations.revoke.id,
  intakeCredentialOperations.rotate.id,
  intakeCredentialOperations.update_metadata.id,
  llmOperations.create.id,
  llmOperations.login_code.id,
  llmOperations.rotate.id,
  missionOperations["finding.create"].id,
  missionOperations["finding.decide"].id,
  missionOperations["finding.update"].id,
  missionOperations["followup.decide"].id,
  missionOperations["inbox_item.done"].id,
  projectOperations["binding.environment.rebuild"].id,
  projectOperations["binding.environment.set"].id,
  environmentSecretOperations.archive.id,
  environmentSecretOperations.create.id,
  environmentSecretOperations.revoke.id,
  environmentSecretOperations.rotate.id,
  environmentSecretOperations.update_metadata.id,
  projectOperations["environment.cache_volume.delete"].id,
  projectOperations["environment.delete"].id,
  repositoryOperations.create.id,
  repositoryOperations.rotate.id,
  repositoryOperations.ssh_key_create.id,
  repositoryOperations.ssh_key_rotate.id,
  repositoryOperations.host_key_pin.id,
  storageOperations.create.id,
  storageOperations.rotate.id,
  trackingOperations.causeLabel.id,
  trackingOperations.traceDelete.id,
  workerOperations["instance.create"].id,
  workerOperations["instance.rotate"].id,
  workerOperations["instance.session.delete"].id,
  workerOperations["instance.tool_output.delete"].id,
  workerOperations["instance.workspace.delete"].id,
  workerOperations["machine.archive"].id,
  workerOperations["machine.create"].id,
  workerOperations["machine.rotate"].id,
  workerOperations["slot_image.delete"].id,
]);

export const REVERSIBLE_OPERATIONS: ReadonlySet<string> = new Set([
  missionOperations["node.pause"].id,
  missionOperations["node.resume"].id,
  missionOperations["node.check"].id,
  missionOperations["node.priority.set"].id,
  missionOperations["dependency.add"].id,
  missionOperations["dependency.remove"].id,
  projectOperations.pause.id,
  projectOperations.resume.id,
  agentOperations["cooldown.clear"].id,
]);

export const GuardAction = {
  Run: "run",
  Block: "block",
  Confirm: "confirm",
  Auto: "auto",
} as const;

export type GuardDecision =
  | { action: typeof GuardAction.Run }
  | { action: typeof GuardAction.Block; reason: string }
  | { action: typeof GuardAction.Confirm; guard: GuardInfo }
  | { action: typeof GuardAction.Auto; reason: string };

export type GuardClassifier = (
  request: GuardRequest,
) => Promise<ClassifyResult>;

export interface GuardRun {
  agentName: string;
  request: string;
  autoMode(): boolean;
  classifier(): Promise<GuardClassifier | null>;
}

const NO_RETIREMENTS = 0;

function importBody(input: unknown): Record<string, unknown> | undefined {
  if (!isObject(input)) return undefined;
  const { body } = input as { body?: unknown };
  return isObject(body) ? (body as Record<string, unknown>) : undefined;
}

function block(reason: string): GuardDecision {
  return { action: GuardAction.Block, reason };
}

function confirm(
  cause: GuardCause,
  verdict: Pick<GuardInfo, "reason" | "confidence"> = {
    reason: null,
    confidence: null,
  },
): GuardDecision {
  return { action: GuardAction.Confirm, guard: { cause, ...verdict } };
}

function importBlock(input: unknown): GuardDecision | undefined {
  const body = importBody(input);
  if (!body) return undefined;
  const retirements = body.confirmed_retirements;
  if (
    retirements !== undefined &&
    !(Array.isArray(retirements) && retirements.length === NO_RETIREMENTS)
  )
    return block(WORKBENCH_IMPORT_RETIREMENT_TEXT);
  if (body.format === ImportFormat.Markdown)
    return block(WORKBENCH_IMPORT_FORMAT_TEXT);
  return undefined;
}

export function floorOf(
  operation: Operation,
  input: unknown,
): GuardDecision | undefined {
  if (operation.mutation !== true) return { action: GuardAction.Run };
  if (HUMAN_ONLY_OPERATIONS.has(operation.id))
    return block(workbenchHumanOnlyText(operation.id));
  if (operation.id === missionOperations["import.apply"].id)
    return importBlock(input) ?? confirm(GuardCause.Import);
  return undefined;
}

export function guardClassOf(operation: Operation): GuardClass {
  if (operation.mutation !== true) return GuardClass.Read;
  if (REVERSIBLE_OPERATIONS.has(operation.id)) return GuardClass.Reversible;
  return floorOf(operation, {}) === undefined
    ? GuardClass.Judged
    : GuardClass.Card;
}

function classified(result: ClassifyResult, run: GuardRun): GuardDecision {
  if (result.kind === ClassifyKind.Aborted)
    return block(WORKBENCH_REJECTION_REASON);
  if (result.kind === ClassifyKind.Failed) return confirm(result.cause);
  if (!run.autoMode()) return confirm(GuardCause.AutoModeOff);
  const decision = decide(result.verdict, run.request);
  if (decision.tier === GuardTier.Auto)
    return { action: GuardAction.Auto, reason: result.verdict.reason };
  return confirm(decision.cause, {
    reason: result.verdict.reason,
    confidence: result.verdict.confidence,
  });
}

export async function guardDecision(
  operation: Operation,
  input: unknown,
  run: GuardRun,
): Promise<GuardDecision> {
  const floor = floorOf(operation, input);
  if (floor) return floor;
  if (!run.autoMode()) return confirm(GuardCause.AutoModeOff);
  if (REVERSIBLE_OPERATIONS.has(operation.id))
    return { action: GuardAction.Auto, reason: GuardCause.Reversible };
  const classify = await run.classifier();
  if (!classify) return confirm(GuardCause.Unavailable);
  const call: GuardCall = {
    operation_id: operation.id,
    description: operation.description,
    input,
  };
  const result = await classify(guardRequest(run.request, call, run.agentName));
  return classified(result, run);
}

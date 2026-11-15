import { agentOperations } from "../agent/contract.ts";
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
  WORKBENCH_IMPORT_FORMAT_TEXT,
  WORKBENCH_IMPORT_RETIREMENT_TEXT,
  workbenchHumanOnlyText,
  workbenchOperations,
} from "./contract.ts";

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
  workbenchOperations["session.abort"].id,
  workbenchOperations["session.queue.remove"].id,
  workbenchOperations["session.action.report"].id,
  workbenchOperations["session.autoMode.set"].id,
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

export const GuardAction = {
  Run: "run",
  Block: "block",
  Confirm: "confirm",
} as const;

export type GuardDecision =
  | { action: typeof GuardAction.Run }
  | { action: typeof GuardAction.Block; reason: string }
  | { action: typeof GuardAction.Confirm };

const NO_RETIREMENTS = 0;

function importBody(input: unknown): Record<string, unknown> | undefined {
  if (!isObject(input)) return undefined;
  const { body } = input as { body?: unknown };
  return isObject(body) ? (body as Record<string, unknown>) : undefined;
}

function block(reason: string): GuardDecision {
  return { action: GuardAction.Block, reason };
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

export function floorOf(operation: Operation, input: unknown): GuardDecision {
  if (operation.mutation !== true) return { action: GuardAction.Run };
  if (HUMAN_ONLY_OPERATIONS.has(operation.id))
    return block(workbenchHumanOnlyText(operation.id));
  if (operation.id === missionOperations["import.apply"].id)
    return importBlock(input) ?? { action: GuardAction.Confirm };
  return { action: GuardAction.Confirm };
}

import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import {
  AssessmentResult,
  AssetKind,
  gateFilesSchema,
  type AssessmentSubmit,
  type GateFiles,
} from "./contract.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import type { AssessmentRow } from "./record-store.ts";
import type { Dependencies } from "./service.ts";

const NO_PATHS: string[] = [];
const NO_GATE_FILES: GateFiles = [];
const NO_ENTRY_PATHS = 0;

export function gateFilesOf(
  assessment: Pick<AssessmentRow, "gate_files"> | null,
  bindingId: string,
): string[] {
  if (assessment === null || assessment.gate_files === null) return NO_PATHS;
  const entry = gateFilesSchema
    .parse(JSON.parse(assessment.gate_files))
    .find((candidate) => candidate.binding_id === bindingId);
  return entry === undefined ? NO_PATHS : entry.paths;
}

export async function serverGateFiles(
  dependencies: Pick<Dependencies, "store" | "bindings" | "intakeGateFiles">,
  caller: CallerContext,
  nodeId: string,
  body: AssessmentSubmit,
): Promise<GateFiles> {
  if (body.result !== AssessmentResult.Success) return NO_GATE_FILES;
  const claim = caller.execution;
  assert.ok(claim && caller.identity);
  if (claim.nodeId !== nodeId) return NO_GATE_FILES;
  const baseBranches = new Map<string, string>();
  dependencies.store.transaction((tx) => {
    for (const action of requiredActionsOf(
      tx,
      dependencies.bindings,
      claim.nodeId,
      claim.pinnedRevision,
    ))
      baseBranches.set(action.binding_id, action.configuration.base_branch);
  });
  const addresses = Array.isArray(body.tested_input)
    ? body.tested_input
    : [body.tested_input];
  const commits = new Map<string, string>();
  for (const address of addresses)
    if (address.kind === AssetKind.Repository)
      commits.set(address.binding_id, address.commit);
  const call = {
    context: caller.context,
    identity: caller.identity,
    executionId: claim.executionId,
  };
  const found: GateFiles = [];
  for (const bindingId of [...baseBranches.keys()].sort()) {
    const commit = commits.get(bindingId);
    if (commit === undefined) continue;
    const { paths } = await dependencies.intakeGateFiles.read(call, {
      binding_id: bindingId,
      base_branch: baseBranches.get(bindingId)!,
      commit,
    });
    if (paths.length > NO_ENTRY_PATHS)
      found.push({ binding_id: bindingId, paths });
  }
  return found;
}

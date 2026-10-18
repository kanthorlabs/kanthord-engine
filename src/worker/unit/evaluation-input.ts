import { addedFiles } from "./local-git.ts";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ensureDirectory } from "../../kernel/files.ts";
import { abortSignal, CancellationContext } from "../../kernel/context.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  AssetKind,
  type Evidence,
  type EvidenceAsset,
  type Revision,
} from "../../mission/contract.ts";
import { EndReason, type ExecutionRun } from "./execution-run.ts";
import {
  EVIDENCE_DIRECTORY,
  WorkspaceKind,
  type ExamineCheckout,
} from "./workspace.ts";
import type { StepsInput } from "./steps-implement.ts";
import type { TestedInput } from "./verification.ts";
import { ExecutionIntent } from "../contract.ts";

const NO_SNAPSHOTS = 0;

export function snapshotOf(evidence: readonly Evidence[], bindingId: string) {
  const candidates = evidence
    .filter((item) => !item.verification && !item.requirement_key)
    .toSorted((a, b) => b.id.localeCompare(a.id));
  for (const item of candidates) {
    const asset = item.assets.find(
      (asset) =>
        asset.kind === AssetKind.Repository &&
        asset.address.binding_id === bindingId,
    );
    if (asset?.kind === AssetKind.Repository)
      return { evidenceId: item.id, commit: asset.address.commit };
  }
  return null;
}

export function placedOf(evidence: readonly Evidence[]) {
  const candidates = evidence
    .filter((item) => !item.verification && !item.requirement_key)
    .toSorted((a, b) => b.id.localeCompare(a.id));
  for (const item of candidates) {
    const asset = item.assets.find(
      (asset) =>
        asset.kind === AssetKind.Produced || asset.kind === AssetKind.Object,
    );
    if (
      asset &&
      (asset.kind === AssetKind.Produced || asset.kind === AssetKind.Object)
    )
      return { evidenceId: item.id, asset };
  }
  return null;
}

async function placeAsset(
  directory: string,
  run: ExecutionRun,
  asset: EvidenceAsset,
  deadline: number,
) {
  const content = await run.call((options) =>
    run.clients.mission["execution.evidence.asset.content.get"](
      {
        params: {
          execution_id: run.claim.execution_id,
          asset_id: asset.id,
        },
        query: {},
        body: null,
      },
      options,
    ),
  );
  const context = new CancellationContext(run.operationContext, deadline);
  const bridge = abortSignal(context);
  try {
    let bytes: Buffer;
    if ("data" in content) bytes = Buffer.from(content.data, "base64");
    else {
      const response = await fetch(content.get_url, { signal: bridge.signal });
      if (!response.ok) {
        await response.body?.cancel();
        return run.stop(EndReason.OperationFailed);
      }
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const assetId = identitySchema("evidence_asset").parse(asset.id);
    await writeFile(join(directory, assetId), bytes, {
      mode: 0o600,
      flag: "wx",
      signal: bridge.signal,
    });
    return assetId;
  } finally {
    bridge.dispose();
    context.cancel();
  }
}

async function prepareWorkspace(
  input: StepsInput,
  run: ExecutionRun,
  intent: ExecutionIntent,
  evidence: readonly Evidence[],
) {
  const deadline = Math.min(
    input.claim.created_at + input.setup.resource_budget.wall_time_ms,
    input.claim.expired_at,
  );
  const common = {
    executionId: input.claim.execution_id,
    transport: input.transport,
    context: run.operationContext,
    deadlineMs: deadline - Date.now(),
  };
  if (intent === ExecutionIntent.Implement) {
    const snapshots = input.setup.repositories.map((repository) => ({
      repository,
      snapshot: snapshotOf(evidence, repository.binding_id),
    }));
    const found = snapshots.flatMap(({ repository, snapshot }) =>
      snapshot ? [{ repository, ...snapshot }] : [],
    );
    if (found.length > NO_SNAPSHOTS) {
      if (found.length < snapshots.length)
        return run.stop(EndReason.OperationFailed);
      const workspace = await input.workspaces.prepareSnapshots({
        ...common,
        snapshots: found,
      });
      try {
        return {
          ...workspace,
          evidenceIds: [...new Set(found.map((item) => item.evidenceId))],
          addedFiles: await addedFilesOf(input, run, workspace, deadline),
        };
      } catch (error) {
        input.workspaces.release(workspace.key, WorkspaceKind.Execution);
        throw error;
      }
    }
  }
  if (intent === ExecutionIntent.Examine)
    return {
      ...(await input.workspaces.prepareExamine({
        ...common,
        repositories: input.setup.repositories,
      })),
      evidenceIds: [] as string[],
      addedFiles: [],
    };
  const { directory } = input.workspaces.prepareExecution(common);
  return {
    key: directory,
    directory,
    checkouts: [] as ExamineCheckout[],
    tested_input: null,
    evidenceIds: [] as string[],
    addedFiles: [],
  };
}

async function addedFilesOf(
  input: StepsInput,
  run: ExecutionRun,
  workspace: { directory: string; checkouts: readonly ExamineCheckout[] },
  deadline: number,
): Promise<string[]> {
  const files: string[] = [];
  for (const checkout of workspace.checkouts) {
    const prefix = relative(workspace.directory, checkout.directory);
    for (const file of await addedFiles(
      input.env,
      checkout.directory,
      `origin/${checkout.base_branch}`,
      run.operationContext,
      deadline - Date.now(),
    ))
      files.push(prefix ? join(prefix, file) : file);
  }
  return files;
}

export async function prepareEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  intent: ExecutionIntent,
  evidence: readonly Evidence[],
) {
  const workspace = await prepareWorkspace(input, run, intent, evidence);
  try {
    const testedInput: TestedInput | undefined =
      workspace.tested_input ?? placedOf(evidence)?.asset.address;
    if (!testedInput) return run.stop(EndReason.OperationFailed);
    const evidenceIds = new Set(workspace.evidenceIds);
    const assets: { evidence_id: string; asset_id: string; path: string }[] =
      [];
    const support = evidence.filter(
      (item) => !item.verification && !item.requirement_key,
    );
    const selected = support.flatMap((item) =>
      item.assets
        .filter(
          (asset) =>
            asset.kind === AssetKind.Produced ||
            asset.kind === AssetKind.Object,
        )
        .map((asset) => ({ evidenceId: item.id, asset })),
    );
    const deadline = Math.min(
      input.claim.created_at + input.setup.resource_budget.wall_time_ms,
      input.claim.expired_at,
    );
    const placement =
      workspace.key === workspace.directory
        ? workspace.directory
        : join(workspace.key, EVIDENCE_DIRECTORY);
    ensureDirectory(placement);
    for (const { evidenceId, asset } of selected) {
      const name = await placeAsset(placement, run, asset, deadline);
      const path = relative(workspace.directory, join(placement, name));
      evidenceIds.add(evidenceId);
      assets.push({ evidence_id: evidenceId, asset_id: asset.id, path });
    }
    return {
      key: workspace.key,
      directory: workspace.directory,
      checkouts: workspace.checkouts,
      tested_input: testedInput,
      evidenceIds: [...evidenceIds],
      reviewBundle: {
        evidence: evidence.filter((item) => evidenceIds.has(item.id)),
        assets,
        added_files: workspace.addedFiles,
      },
    };
  } catch (error) {
    input.workspaces.release(workspace.key, WorkspaceKind.Execution);
    throw error;
  }
}

export function verificationCommands(
  revision: Pick<Revision, "content" | "tasks">,
): string[] {
  return [
    ...revision.content.verifications,
    ...revision.tasks.flatMap((task) => task.content.verifications),
  ];
}

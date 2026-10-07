import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abortSignal, CancellationContext } from "../kernel/context.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  AssetKind,
  type Evidence,
  type EvidenceAsset,
  type Revision,
} from "../mission/contract.ts";
import { EndReason, type ExecutionRun } from "./execution-run.ts";
import { NodeKind } from "./native-agent.ts";
import { WorkspaceKind } from "./workspace.ts";
import type { StepsInput } from "./steps-objective.ts";
import type { TestedInput } from "./verification.ts";

export function snapshotOf(evidence: readonly Evidence[], bindingId: string) {
  const candidates = evidence
    .filter((item) => !item.verification && !item.requirementKey)
    .toSorted((a, b) => b.id.localeCompare(a.id));
  for (const item of candidates) {
    const asset = item.assets.find(
      (asset) =>
        asset.kind === AssetKind.Repository &&
        asset.address.bindingId === bindingId,
    );
    if (asset?.kind === AssetKind.Repository)
      return { evidenceId: item.id, commit: asset.address.commit };
  }
  return null;
}

export function placedOf(evidence: readonly Evidence[]) {
  const candidates = evidence
    .filter((item) => !item.verification && !item.requirementKey)
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
          executionId: run.claim.executionId,
          assetId: asset.id,
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
      const response = await fetch(content.getUrl, { signal: bridge.signal });
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
  kind: NodeKind,
  evidence: readonly Evidence[],
) {
  const repository = input.setup.repositories[0];
  const deadline = Math.min(
    input.claim.createdAt + input.setup.resource_budget.wall_time_ms,
    input.claim.expiredAt,
  );
  const common = {
    executionId: input.claim.executionId,
    transport: input.transport,
    context: run.operationContext,
    deadlineMs: deadline - Date.now(),
  };
  if (kind === NodeKind.Objective && repository) {
    const snapshot = snapshotOf(evidence, repository.binding_id);
    if (snapshot) {
      const workspace = await input.workspaces.prepareSnapshot({
        ...common,
        repository,
        commit: snapshot.commit,
      });
      return {
        directory: workspace.directory,
        testedInput: {
          kind: AssetKind.Repository,
          bindingId: repository.binding_id,
          commit: snapshot.commit,
        },
        evidenceIds: [snapshot.evidenceId],
      };
    }
  }
  const workspace =
    kind === NodeKind.Initiative
      ? await input.workspaces.prepareInitiative({
          ...common,
          repositories: input.setup.repositories,
        })
      : { ...input.workspaces.prepareExecution(common), testedInput: null };
  return { ...workspace, evidenceIds: [] as string[] };
}

export async function prepareEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  kind: NodeKind,
  evidence: readonly Evidence[],
) {
  const workspace = await prepareWorkspace(input, run, kind, evidence);
  try {
    const testedInput: TestedInput | undefined =
      workspace.testedInput ?? placedOf(evidence)?.asset.address;
    if (!testedInput) return run.stop(EndReason.OperationFailed);
    const evidenceIds = new Set(workspace.evidenceIds);
    const assets: { evidenceId: string; assetId: string; path: string }[] = [];
    const support = evidence.filter(
      (item) => !item.verification && !item.requirementKey,
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
      input.claim.createdAt + input.setup.resource_budget.wall_time_ms,
      input.claim.expiredAt,
    );
    for (const { evidenceId, asset } of selected) {
      const path = await placeAsset(workspace.directory, run, asset, deadline);
      evidenceIds.add(evidenceId);
      assets.push({ evidenceId, assetId: asset.id, path });
    }
    return {
      directory: workspace.directory,
      testedInput,
      evidenceIds: [...evidenceIds],
      reviewBundle: {
        evidence: evidence.filter((item) => evidenceIds.has(item.id)),
        assets,
      },
    };
  } catch (error) {
    input.workspaces.release(workspace.directory, WorkspaceKind.Execution);
    throw error;
  }
}

export function verificationCommands(
  revision: Pick<Revision, "content" | "tasks">,
): string[] {
  return [
    ...revision.content.verifications,
    ...(revision.tasks ?? []).flatMap((task) => task.content.verifications),
  ];
}

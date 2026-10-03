import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abortSignal, CancellationContext } from "../kernel/context.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  AssetKind,
  type Evidence,
  type Revision,
} from "../mission/contract.ts";
import { EndReason, type ExecutionRun } from "./execution-run.ts";
import { NodeKind } from "./native-agent.ts";
import { WorkspaceKind } from "./workspace.ts";
import type { StepsInput } from "./steps-objective.ts";

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

async function placeEvidence(
  directory: string,
  run: ExecutionRun,
  evidence: readonly Evidence[],
  deadline: number,
) {
  const placed = placedOf(evidence);
  if (!placed) return run.stop(EndReason.OperationFailed);
  const content = await run.call((options) =>
    run.clients.mission["execution.evidence.asset.content.get"](
      {
        params: {
          executionId: run.claim.executionId,
          assetId: placed.asset.id,
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
    const assetId = identitySchema("evidence_asset").parse(placed.asset.id);
    await writeFile(join(directory, assetId), bytes, {
      mode: 0o600,
      flag: "wx",
      signal: bridge.signal,
    });
    return {
      directory,
      testedInput: placed.asset.address,
      evidenceIds: [placed.evidenceId],
    };
  } finally {
    bridge.dispose();
    context.cancel();
  }
}

export async function prepareEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  kind: NodeKind,
  evidence: readonly Evidence[],
) {
  const repository = input.setup.repositories[0];
  const deadline = Math.min(
    input.claim.createdAt + input.setup.resourceBudget.wallTimeMs,
    input.claim.expiredAt,
  );
  const common = {
    executionId: input.claim.executionId,
    transport: input.transport,
    context: run.operationContext,
    deadlineMs: deadline - Date.now(),
  };
  if (kind === NodeKind.Objective && repository) {
    const snapshot = snapshotOf(evidence, repository.bindingId);
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
          bindingId: repository.bindingId,
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
  if (workspace.testedInput)
    return {
      directory: workspace.directory,
      testedInput: workspace.testedInput,
      evidenceIds: [] as string[],
    };
  try {
    return await placeEvidence(workspace.directory, run, evidence, deadline);
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

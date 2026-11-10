import {
  addedFiles,
  changePatch,
  modifiedFiles,
  onFirstParentChain,
  roundFiles,
  roundPatch,
} from "./local-git.ts";
import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ensureDirectory } from "../../kernel/files.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  AssetKind,
  type Evidence,
  type EvidenceAsset,
  type ReviewRound,
  type Revision,
} from "../../mission/contract.ts";
import { EndReason, type ExecutionRun } from "./execution-run.ts";
import {
  BASE_DIRECTORY,
  EVIDENCE_DIRECTORY,
  type ExamineCheckout,
  WorkspaceKind,
} from "./workspace.ts";
import type { StepsInput } from "./steps-implement.ts";
import type { TestedInput } from "./verification.ts";
import {
  BaseHead,
  namedCheckouts,
  SetupEnd,
  setupEntries,
  type SetupFailure,
  setUpHeads,
} from "./environment-setup.ts";
import { ExecutionIntent } from "../contract.ts";
import { AFFECTED_SUBJECT } from "./affected.ts";
import { CODER_REPORT_SUBJECT } from "./coder-report.ts";
import { ROUND_PATCH_SUBJECT, roundPatchName } from "./round-patch.ts";

const NO_SNAPSHOTS = 0;
const NO_PATCH_BYTES = 0;

function isSupportEvidence(item: Evidence): boolean {
  return (
    !item.verification &&
    !item.requirement_key &&
    item.subject !== AFFECTED_SUBJECT &&
    item.subject !== ROUND_PATCH_SUBJECT
  );
}

interface BindingPatch {
  binding_id: string;
  name: string;
  text: string;
}

interface ReviewScope {
  addedFiles: string[];
  changedFiles: string[];
  patches: BindingPatch[];
  emptyPatches: string[];
}

function withLatestCoderReport(support: readonly Evidence[]): Evidence[] {
  const latest = support
    .filter((item) => item.subject === CODER_REPORT_SUBJECT)
    .map((item) => item.id)
    .toSorted()
    .at(-1);
  return support.filter(
    (item) => item.subject !== CODER_REPORT_SUBJECT || item.id === latest,
  );
}

export function snapshotOf(evidence: readonly Evidence[], bindingId: string) {
  const candidates = evidence
    .filter(isSupportEvidence)
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
    .filter(isSupportEvidence)
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
  try {
    let bytes: Buffer;
    if ("data" in content) bytes = Buffer.from(content.data, "base64");
    else {
      const response = await fetch(content.get_url, { signal: context.signal });
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
      signal: context.signal,
    });
    return assetId;
  } finally {
    context.cancel();
  }
}

const NO_SCOPE: ReviewScope = {
  addedFiles: [],
  changedFiles: [],
  patches: [],
  emptyPatches: [],
};

async function prepareWorkspace(
  input: StepsInput,
  run: ExecutionRun,
  intent: ExecutionIntent,
  evidence: readonly Evidence[],
  round: ReviewRound,
) {
  const deadline = Math.min(
    input.claim.created_at + input.setup.resource_budget.wall_time_ms,
    input.claim.expired_at,
  );
  const common = {
    env: input.env,
    executionId: input.claim.execution_id,
    nodeId: input.claim.node_id,
    log: (msg: string, fields: Record<string, unknown>) => run.log(msg, fields),
    transport: input.transport,
    sshAccess: input.sshAccess,
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
          scope: await reviewScopeOf(
            input,
            run,
            workspace,
            found,
            round,
            deadline,
          ),
        };
      } catch (error) {
        input.workspaces.release(workspace.key, workspace.kind);
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
      scope: NO_SCOPE,
    };
  const { directory } = input.workspaces.prepareExecution(common);
  return {
    key: directory,
    directory,
    checkouts: [] as ExamineCheckout[],
    tested_input: null,
    kind: WorkspaceKind.Execution,
    evidenceIds: [] as string[],
    scope: NO_SCOPE,
  };
}

function reviewBaseCommit(
  reviewBase: TestedInput | null,
  bindingId: string,
): string | null {
  if (reviewBase === null) return null;
  const addresses = Array.isArray(reviewBase) ? reviewBase : [reviewBase];
  const address = addresses.find(
    (entry) =>
      entry.kind === AssetKind.Repository && entry.binding_id === bindingId,
  );
  return address?.kind === AssetKind.Repository ? address.commit : null;
}

function existsAt(directory: string, file: string): boolean {
  return (
    lstatSync(join(directory, file), { throwIfNoEntry: false }) !== undefined
  );
}

interface RepositorySnapshot {
  repository: { binding_id: string; name: string };
  commit: string;
}

interface ReviewScopeContext {
  input: StepsInput;
  run: ExecutionRun;
  round: ReviewRound;
  deadline: number;
  workspaceDirectory: string;
  snapshots: readonly RepositorySnapshot[];
}

interface CheckoutScopeEntry {
  checkout: ExamineCheckout;
  prefixed: (file: string) => string;
  snapshot: RepositorySnapshot | undefined;
  base: string | null;
}

function checkoutScopeEntry(
  context: ReviewScopeContext,
  checkout: ExamineCheckout,
): CheckoutScopeEntry {
  const prefix = relative(context.workspaceDirectory, checkout.directory);
  const snapshot = context.snapshots.find(
    (entry) => entry.repository.name === checkout.name,
  );
  return {
    checkout,
    prefixed: (file) => (prefix ? join(prefix, file) : file),
    snapshot,
    base:
      snapshot === undefined
        ? null
        : reviewBaseCommit(
            context.round.review_base,
            snapshot.repository.binding_id,
          ),
  };
}

async function nodeHistoryScope(
  context: ReviewScopeContext,
  entry: CheckoutScopeEntry,
  scope: ReviewScope,
): Promise<boolean> {
  const { input, run, deadline } = context;
  const { checkout, prefixed, snapshot, base } = entry;
  if (snapshot === undefined || base === null) return false;
  if (
    !(await onFirstParentChain(
      input.env,
      checkout.directory,
      base,
      run.operationContext,
      deadline - Date.now(),
    ))
  )
    return false;
  const read = (added: boolean) =>
    roundFiles(
      input.env,
      checkout.directory,
      base,
      added,
      run.operationContext,
      deadline - Date.now(),
    );
  scope.changedFiles.push(...(await read(false)).map(prefixed));
  scope.addedFiles.push(
    ...(await read(true))
      .filter((file) => existsAt(checkout.directory, file))
      .map(prefixed),
  );
  scope.patches.push({
    binding_id: snapshot.repository.binding_id,
    name: checkout.name,
    text: await roundPatch(
      input.env,
      checkout.directory,
      base,
      run.operationContext,
      deadline - Date.now(),
    ),
  });
  return true;
}

async function originScope(
  context: ReviewScopeContext,
  entry: CheckoutScopeEntry,
  scope: ReviewScope,
): Promise<void> {
  const { input, run, round, deadline } = context;
  const { checkout, prefixed, snapshot, base } = entry;
  if (round.review_base !== null)
    run.log("review base off the node history", {
      binding: checkout.name,
      review_base: base,
    });
  const origin = `origin/${checkout.base_branch}`;
  scope.addedFiles.push(
    ...(
      await addedFiles(
        input.env,
        checkout.directory,
        origin,
        run.operationContext,
        deadline - Date.now(),
      )
    ).map(prefixed),
  );
  scope.changedFiles.push(
    ...(
      await modifiedFiles(
        input.env,
        checkout.directory,
        origin,
        run.operationContext,
        deadline - Date.now(),
      )
    ).map(prefixed),
  );
  if (round.review_base === null || snapshot === undefined) return;
  const text = await changePatch(
    input.env,
    checkout.directory,
    origin,
    run.operationContext,
    deadline - Date.now(),
  );
  if (text.length === NO_PATCH_BYTES) {
    scope.emptyPatches.push(checkout.name);
    return;
  }
  scope.patches.push({
    binding_id: snapshot.repository.binding_id,
    name: checkout.name,
    text,
  });
}

async function reviewScopeOf(
  input: StepsInput,
  run: ExecutionRun,
  workspace: { directory: string; checkouts: readonly ExamineCheckout[] },
  snapshots: readonly RepositorySnapshot[],
  round: ReviewRound,
  deadline: number,
): Promise<ReviewScope> {
  const scope: ReviewScope = {
    addedFiles: [],
    changedFiles: [],
    patches: [],
    emptyPatches: [],
  };
  const context: ReviewScopeContext = {
    input,
    run,
    round,
    deadline,
    workspaceDirectory: workspace.directory,
    snapshots,
  };
  for (const checkout of workspace.checkouts) {
    const entry = checkoutScopeEntry(context, checkout);
    if (entry.snapshot !== undefined && entry.base === entry.snapshot.commit) {
      scope.emptyPatches.push(checkout.name);
      continue;
    }
    if (await nodeHistoryScope(context, entry, scope)) continue;
    await originScope(context, entry, scope);
  }
  scope.changedFiles.sort();
  return scope;
}

function testedCommits(testedInput: TestedInput): string[] {
  const addresses = Array.isArray(testedInput) ? testedInput : [testedInput];
  return addresses.flatMap((address) =>
    "commit" in address ? [address.commit] : [],
  );
}

async function setUpReview(
  input: StepsInput,
  run: ExecutionRun,
  workspace: { key: string; checkouts: readonly ExamineCheckout[] },
  testedInput: TestedInput,
  deadline: number,
): Promise<{ base: BaseHead | null; setupFailure: SetupFailure | null }> {
  if (!workspace.checkouts.length) return { base: null, setupFailure: null };
  const setupInput = {
    env: input.env,
    context: run.operationContext,
    deadline,
    spans: run.spans,
  };
  const setup = await setupEntries(
    setupInput,
    namedCheckouts(input.setup.repositories, workspace.checkouts),
  );
  const base = new BaseHead(
    setupInput,
    { directory: join(workspace.key, BASE_DIRECTORY) },
    setup,
  );
  const result = await setUpHeads(
    setupInput,
    setup,
    base,
    testedCommits(testedInput),
  );
  if (result.end === SetupEnd.BudgetEnd)
    return run.stop(EndReason.AssessmentAbsent);
  if (result.end === SetupEnd.Failed)
    run.log("setup failed on the node head", {
      exit_codes: result.run.verification.results.map(
        (entry) => entry.exit_code,
      ),
    });
  return {
    base,
    setupFailure: result.end === SetupEnd.Failed ? result : null,
  };
}

export async function prepareEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  intent: ExecutionIntent,
  evidence: readonly Evidence[],
  round: ReviewRound,
) {
  const workspace = await prepareWorkspace(input, run, intent, evidence, round);
  try {
    const testedInput: TestedInput | undefined =
      workspace.tested_input ?? placedOf(evidence)?.asset.address;
    if (!testedInput) return run.stop(EndReason.OperationFailed);
    const evidenceIds = new Set(workspace.evidenceIds);
    const assets: { evidence_id: string; asset_id: string; path: string }[] =
      [];
    const support = withLatestCoderReport(evidence.filter(isSupportEvidence));
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
    const { base, setupFailure } = await setUpReview(
      input,
      run,
      workspace,
      testedInput,
      deadline,
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
    const patches: (BindingPatch & { path: string })[] = [];
    for (const patch of workspace.scope.patches) {
      const file = join(placement, roundPatchName(round.round, patch.name));
      await writeFile(file, patch.text, { mode: 0o600, flag: "wx" });
      patches.push({ ...patch, path: relative(workspace.directory, file) });
    }
    return {
      key: workspace.key,
      kind: workspace.kind,
      directory: workspace.directory,
      checkouts: workspace.checkouts,
      tested_input: testedInput,
      base,
      setupFailure,
      evidenceIds: [...evidenceIds],
      patches: patches.filter((patch) => patch.text.length > NO_PATCH_BYTES),
      reviewBundle: {
        evidence: evidence.filter((item) => evidenceIds.has(item.id)),
        assets,
        added_files: workspace.scope.addedFiles,
        changed_files: workspace.scope.changedFiles,
        ...(round.review_base === null
          ? {}
          : {
              round: { number: round.round, review_base: round.review_base },
              patch_paths: patches.map((patch) => patch.path),
              empty_patches: workspace.scope.emptyPatches,
            }),
      },
    };
  } catch (error) {
    input.workspaces.release(workspace.key, workspace.kind);
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

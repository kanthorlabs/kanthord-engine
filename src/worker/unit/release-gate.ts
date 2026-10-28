import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import {
  AffectedVerdict,
  nodeVerdict,
  runAffected,
  type AffectedResult,
  type AffectedRun,
} from "./affected.ts";
import { refreshAtRelease, RefreshResult } from "./base-refresh.ts";
import { verificationCommands } from "./evaluation-input.ts";
import {
  affectedRevisionInstruction,
  releaseRevisionInstruction,
} from "./judgement.ts";
import { checkoutDetached, cloneLocal, matchRemote } from "./local-git.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  verificationObserver,
  VerificationContext,
} from "./method-telemetry.ts";
import { repositoryOf, type StepsState } from "./steps-implement.ts";
import {
  environmentStop,
  infrastructureStop,
  runVerificationsWithOutput,
  testedInputOf,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import { verificationFactsOf } from "./progress-rule.ts";
import { CHECKOUTS_DIRECTORY, RELEASE_DIRECTORY } from "./workspace.ts";
import { SpanOperation } from "./telemetry.ts";
import { SetupEnd, setUpHeads, type SetupEntry } from "./environment-setup.ts";

const EXIT_SUCCESS = 0;
const NOT_FOUND = -1;
const PARENT = "..";
const RELEASE_GATE_RESULT = "kanthord.release_gate.result";
const RELEASE_GATE_UNIT_ID = "kanthord.release_gate.unit_id";
const RELEASE_GATE_AFFECTED = "kanthord.release_gate.affected";

export const ReleaseGateKind = {
  Passed: "passed",
  BudgetEnd: "budget_end",
  Routed: "routed",
} as const;
export type ReleaseGate =
  | { kind: typeof ReleaseGateKind.Passed }
  | { kind: typeof ReleaseGateKind.BudgetEnd }
  | {
      kind: typeof ReleaseGateKind.Routed;
      unit: TaskContent;
      instruction: string;
    };

export function nodeUnitOf(
  nodeId: string,
  revision: Pick<Revision, "filename" | "content">,
): TaskContent {
  assert.ok(nodeId);
  return { id: nodeId, filename: revision.filename, content: revision.content };
}

export function commandOwners(
  state: Pick<StepsState, "input" | "revision">,
): TaskContent[] {
  const node = nodeUnitOf(state.input.claim.node_id, state.revision);
  return [
    ...state.revision.content.verifications.map(() => node),
    ...state.revision.tasks.flatMap((task) =>
      task.content.verifications.map(() => task),
    ),
  ];
}

export function releaseGate(state: StepsState): Promise<ReleaseGate> {
  const spans = state.run.spans;
  const affected: AffectedNote = { verdict: null };
  return spans.within(
    {
      key: spans.key(SpanOperation.ReleaseGate),
      operation: SpanOperation.ReleaseGate,
    },
    () => gateRelease(state, affected),
    (gate) => ({
      status: SpanStatus.Ok,
      attributes: {
        [RELEASE_GATE_RESULT]: gate.kind,
        ...(affected.verdict === null
          ? {}
          : { [RELEASE_GATE_AFFECTED]: affected.verdict }),
        ...(gate.kind === ReleaseGateKind.Routed
          ? { [RELEASE_GATE_UNIT_ID]: gate.unit.id }
          : {}),
      },
    }),
  );
}

interface AffectedNote {
  verdict: AffectedVerdict | null;
}

async function gateRelease(
  state: StepsState,
  note: AffectedNote,
): Promise<ReleaseGate> {
  if ((await refreshAtRelease(state)) === RefreshResult.BudgetEnd)
    return { kind: ReleaseGateKind.BudgetEnd };
  const commands = verificationCommands(state.revision);
  const owners = commandOwners(state);
  assert.equal(owners.length, commands.length);
  const checked = await verifyInReleaseClones(state, commands);
  const run = checked.run;
  state.run.noteVerification(
    run.verification.results.at(-1)?.timed_out ?? false,
  );
  if (run.outcome === VerificationClass.BudgetEnd) {
    state.agent.budget.wallDeadlineReached();
    return { kind: ReleaseGateKind.BudgetEnd };
  }
  const stop = infrastructureStop(run) ?? environmentStop(run);
  if (stop) throw stop;
  const affected = checked.affected;
  note.verdict = affected?.verdict ?? null;
  const passed =
    !checked.setup &&
    verificationPassed(run.verification, commands) &&
    affected?.verdict !== AffectedVerdict.Failed;
  state.lastVerification = verificationFactsOf(passed, run.verification);
  state.run.log("release verified", {
    commits: state.checkouts.map((checkout) => checkout.head),
    passed,
    setup: checked.setup,
    exit_codes: run.verification.results.map((result) => result.exit_code),
    ...(affected ? { affected: affected.verdict } : {}),
  });
  if (passed) return { kind: ReleaseGateKind.Passed };
  if (affected?.verdict === AffectedVerdict.Failed)
    return {
      kind: ReleaseGateKind.Routed,
      unit: nodeUnitOf(state.input.claim.node_id, state.revision),
      instruction: affectedRevisionInstruction(
        state.input.setup.templates,
        affected.failed,
      ),
    };
  const owner = checked.setup
    ? nodeUnitOf(state.input.claim.node_id, state.revision)
    : owners[firstFailedIndex(run)];
  assert.ok(owner);
  return {
    kind: ReleaseGateKind.Routed,
    unit: owner,
    instruction: releaseRevisionInstruction(
      state.input.setup.templates,
      run.verification,
      checked.commands,
      run.outputs.at(-1) ?? "",
    ),
  };
}

function firstFailedIndex(run: VerificationRun): number {
  const results = run.verification.results;
  const index = results.findIndex(
    (result) => result.exit_code !== EXIT_SUCCESS,
  );
  return index === NOT_FOUND ? results.length : index;
}

interface ReleaseCheck {
  run: VerificationRun;
  commands: readonly string[];
  setup: boolean;
  affected: AffectedCheck | null;
}

interface AffectedCheck {
  verdict: AffectedVerdict;
  failed: AffectedRun[];
}

function budgetEndRun(state: StepsState): VerificationRun {
  return {
    verification: { tested_input: testedInputOf(state.checkouts), results: [] },
    outputs: [],
    flaky: [],
    outcome: VerificationClass.BudgetEnd,
  };
}

async function setUpReleaseClones(
  state: StepsState,
  key: string,
  base: string,
): Promise<ReleaseCheck | null> {
  const checkouts = join(key, CHECKOUTS_DIRECTORY);
  const clones: SetupEntry[] = state.setup.map((entry) => ({
    ...entry,
    directory: join(base, layoutOf(checkouts, entry.directory)),
  }));
  const result = await setUpHeads(
    {
      env: state.input.env,
      context: state.run.operationContext,
      deadline: state.agent.budget.wallDeadline(),
      spans: state.run.spans,
      exhausted: () => state.agent.budget.exhausted(),
    },
    clones,
    state.base,
    state.checkouts.map((checkout) => checkout.head),
  );
  if (result.end === SetupEnd.BudgetEnd)
    return {
      run: budgetEndRun(state),
      commands: [],
      setup: true,
      affected: null,
    };
  if (result.end === SetupEnd.Failed)
    return {
      run: result.run,
      commands: result.commands,
      setup: true,
      affected: null,
    };
  return null;
}

async function verifyInReleaseClones(
  state: StepsState,
  commands: readonly string[],
): Promise<ReleaseCheck> {
  const key = state.input.workspaces.nodeKey(state.input.claim.node_id);
  const base = join(key, RELEASE_DIRECTORY);
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    rmSync(base, { recursive: true, force: true });
    const directory = await buildReleaseClones(state, key, base, cleanup);
    const setup = await setUpReleaseClones(state, key, base);
    if (setup !== null) return setup;
    const testedInput = testedInputOf(state.checkouts);
    const owners = commandOwners(state);
    const run = await runVerificationsWithOutput({
      observe: verificationObserver(
        state.run.spans,
        testedCommitOf(testedInput),
        environmentDigestsOf(state.input.setup.repositories),
        {
          context: VerificationContext.Release,
          ownerOf: (index) => owners[index]!.id,
        },
      ),
      directory,
      commands,
      tested_input: testedInput,
      deadline: state.agent.budget.wallDeadline(),
      context: state.run.operationContext,
      env: state.input.env,
      exhausted: () => state.agent.budget.exhausted(),
      baseline: (command) => state.base.exitOf(command),
    });
    const listed = { run, commands, setup: false, affected: null };
    if (!verificationPassed(run.verification, commands)) return listed;
    const affected = await runAffectedChecks(state, key, base);
    if (affected === null)
      return {
        ...listed,
        run: { ...run, outcome: VerificationClass.BudgetEnd },
      };
    return { ...listed, affected };
  } finally {
    rmSync(base, { recursive: true, force: true });
    cleanup.cancel();
  }
}

async function runAffectedChecks(
  state: StepsState,
  key: string,
  base: string,
): Promise<AffectedCheck | null> {
  const checkouts = join(key, CHECKOUTS_DIRECTORY);
  const results: AffectedResult[] = [];
  for (const checkout of state.checkouts) {
    const result = await runAffected({
      env: state.input.env,
      context: state.run.operationContext,
      deadline: state.agent.budget.wallDeadline(),
      exhausted: () => state.agent.budget.exhausted(),
      spans: state.run.spans,
      scope: VerificationContext.Release,
      workspaceKey: key,
      checkout: {
        binding_id: checkout.binding_id,
        name: checkout.name,
        directory: join(base, layoutOf(checkouts, checkout.directory)),
        base_branch: repositoryOf(state, checkout).strategy.base_branch,
        head: checkout.head,
      },
      digests: environmentDigestsOf(state.input.setup.repositories),
      base: state.base,
    });
    if ("budgetEnd" in result) return null;
    results.push(result);
  }
  return {
    verdict: nodeVerdict(results.map((result) => result.verdict)),
    failed: results.filter(
      (result): result is AffectedRun =>
        result.verdict === AffectedVerdict.Failed,
    ),
  };
}

async function buildReleaseClones(
  state: StepsState,
  key: string,
  base: string,
  context: Context,
): Promise<string> {
  const checkouts = join(key, CHECKOUTS_DIRECTORY);
  const remaining = () => state.input.claim.expired_at - Date.now();
  ensureDirectory(base);
  for (const checkout of state.checkouts) {
    const directory = join(base, layoutOf(checkouts, checkout.directory));
    await cloneLocal(
      state.input.env,
      checkout.directory,
      directory,
      context,
      remaining(),
    );
    await matchRemote(
      state.input.env,
      directory,
      checkout.directory,
      repositoryOf(state, checkout).address,
      context,
      remaining(),
    );
    await checkoutDetached(
      state.input.env,
      directory,
      checkout.head,
      context,
      remaining(),
    );
  }
  return join(base, layoutOf(checkouts, state.root));
}

function layoutOf(checkouts: string, directory: string): string {
  const path = relative(checkouts, directory);
  assert.ok(!path.startsWith(PARENT) && !isAbsolute(path));
  return path;
}

import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import {
  type AffectedResult,
  type AffectedRun,
  AffectedVerdict,
  nodeVerdict,
  runAffected,
} from "./affected.ts";
import { verificationCommands } from "./review-scope.ts";
import {
  affectedRevisionInstruction,
  releaseRevisionInstruction,
} from "./judgement.ts";
import {
  type CommandTree,
  type ImplementPorts,
  type PortCall,
  PortResultKind,
} from "./foundry-ports.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  VerificationContext,
  verificationObserver,
} from "./method-telemetry.ts";
import { portStop } from "./execution-stop.ts";
import type { StepsState } from "./steps-implement.ts";
import { memoScopeOf } from "./verification-memo.ts";
import { repositoryOf } from "./setup-repository.ts";
import {
  environmentStop,
  infrastructureStop,
  runVerificationsWithOutput,
  testedInputOf,
  VERIFICATION_RERUNS,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import { verificationFactsOf } from "./progress-rule.ts";
import { SetupEnd, type SetupEntry, setUpHeads } from "./environment-setup.ts";

const EXIT_SUCCESS = 0;
const NOT_FOUND = -1;
const NO_ITEMS = 0;
export const RELEASE_GATE_RESULT = "kanthord.release_gate.result";
export const RELEASE_GATE_UNIT_ID = "kanthord.release_gate.unit_id";
export const RELEASE_GATE_AFFECTED = "kanthord.release_gate.affected";
const TREE_PREPARED = "tree prepared";
const RELEASE_PURPOSE = "release";

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
  nodeId: string,
  revision: Pick<Revision, "filename" | "content" | "tasks">,
): TaskContent[] {
  const node = nodeUnitOf(nodeId, revision);
  return [
    ...revision.content.verifications.map(() => node),
    ...revision.tasks.flatMap((task) =>
      task.content.verifications.map(() => task),
    ),
  ];
}

export interface AffectedNote {
  verdict: AffectedVerdict | null;
}

export interface VerifiedRelease {
  checked: ReleaseCheck;
  commands: readonly string[];
  owners: readonly TaskContent[];
}

export async function verifyRelease(
  state: StepsState,
  ports: ImplementPorts,
): Promise<VerifiedRelease | null> {
  const commands = verificationCommands(state.revision);
  const owners = commandOwners(state.input.claim.node_id, state.revision);
  assert.equal(owners.length, commands.length);
  const checked = await verifyInReleaseClones(state, { ports, commands });
  const run = checked.run;
  state.verificationTimedOut =
    run.verification.results.at(-1)?.timed_out ?? false;
  if (run.outcome === VerificationClass.BudgetEnd) {
    state.agent.budget.wallDeadlineReached();
    return null;
  }
  const stop = infrastructureStop(run) ?? environmentStop(run);
  if (stop) throw stop;
  if (run.flaky_failures.length > NO_ITEMS)
    state.ports.log.log("verification flaky", {
      flaky: run.flaky_failures.map((failure) => ({
        index: failure.index,
        command: failure.command,
      })),
    });
  return { checked, commands, owners };
}

function releasePassed(verified: VerifiedRelease): boolean {
  const { checked, commands } = verified;
  return (
    !checked.setup &&
    verificationPassed(checked.run.verification, commands) &&
    checked.affected?.verdict !== AffectedVerdict.Failed
  );
}

function routedRelease(
  state: StepsState,
  verified: VerifiedRelease,
): ReleaseGate {
  const { checked, owners } = verified;
  const { run, affected } = checked;
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

export function releaseOutcome(
  state: StepsState,
  verified: VerifiedRelease,
  note: AffectedNote,
): ReleaseGate {
  const { checked } = verified;
  const { run, affected } = checked;
  note.verdict = affected?.verdict ?? null;
  const passed = releasePassed(verified);
  state.lastVerification = verificationFactsOf(passed, run.verification);
  state.ports.log.log("release verified", {
    commits: state.checkouts.map((checkout) => checkout.head),
    passed,
    setup: checked.setup,
    exit_codes: run.verification.results.map((result) => result.exit_code),
    ...(affected ? { affected: affected.verdict } : {}),
  });
  if (passed) return { kind: ReleaseGateKind.Passed };
  return routedRelease(state, verified);
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
    flaky_failures: [],
    outcome: VerificationClass.BudgetEnd,
  };
}

async function setUpReleaseClones(
  state: StepsState,
  trees: readonly CommandTree[],
): Promise<ReleaseCheck | null> {
  const clones: SetupEntry[] = state.setup.map((entry) => ({
    ...entry,
    directory: treeOf(trees, entry.repository.binding_id),
  }));
  const result = await setUpHeads(
    {
      env: state.input.env,
      context: state.cancel,
      deadline: state.agent.budget.wallDeadline(),
      spans: state.ports.telemetry,
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

interface ReleaseVerification {
  ports: ImplementPorts;
  commands: readonly string[];
}

interface ReleaseTrees {
  ports: ImplementPorts;
  call: PortCall;
  trees: CommandTree[];
}

async function verifyInReleaseClones(
  state: StepsState,
  verification: ReleaseVerification,
): Promise<ReleaseCheck> {
  const { ports, commands } = verification;
  const key = state.workspaceKey;
  const cleanup = state.agent.budget.cleanupContext(state.cancel);
  const trees: CommandTree[] = [];
  try {
    await takeReleaseTrees(state, {
      ports,
      call: { context: cleanup, deadline: state.input.claim.expired_at },
      trees,
    });
    const directory = releaseRootOf(state, trees);
    const setup = await setUpReleaseClones(state, trees);
    if (setup !== null) return setup;
    const testedInput = testedInputOf(state.checkouts);
    const owners = commandOwners(state.input.claim.node_id, state.revision);
    const run = await runVerificationsWithOutput({
      observe: verificationObserver(
        state.ports.telemetry,
        testedCommitOf(testedInput),
        environmentDigestsOf(state.input.setup.repositories),
        {
          context: VerificationContext.Release,
          ownerOf: (index) => owners[index]!.id,
        },
      ),
      directory,
      commands,
      copyRepeated: true,
      reruns: VERIFICATION_RERUNS,
      tested_input: testedInput,
      deadline: state.agent.budget.wallDeadline(),
      context: state.cancel,
      env: state.input.env,
      exhausted: () => state.agent.budget.exhausted(),
      baseline: (command) => state.base.exitOf(command),
      memo: await memoScopeOf(state, VerificationContext.Release, commands),
    });
    const listed = { run, commands, setup: false, affected: null };
    if (!verificationPassed(run.verification, commands)) return listed;
    const affected = await runAffectedChecks(state, key, trees);
    if (affected === null)
      return {
        ...listed,
        run: { ...run, outcome: VerificationClass.BudgetEnd },
      };
    return { ...listed, affected };
  } finally {
    try {
      for (const tree of trees) await ports.releaseTrees.give(tree);
    } finally {
      cleanup.cancel();
    }
  }
}

async function runAffectedChecks(
  state: StepsState,
  key: string,
  trees: readonly CommandTree[],
): Promise<AffectedCheck | null> {
  const results: AffectedResult[] = [];
  for (const checkout of state.checkouts) {
    const result = await runAffected({
      env: state.input.env,
      context: state.cancel,
      deadline: state.agent.budget.wallDeadline(),
      exhausted: () => state.agent.budget.exhausted(),
      spans: state.ports.telemetry,
      scope: VerificationContext.Release,
      workspaceKey: key,
      checkout: {
        binding_id: checkout.binding_id,
        name: checkout.name,
        directory: treeOf(trees, checkout.binding_id),
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

async function takeReleaseTrees(
  state: StepsState,
  release: ReleaseTrees,
): Promise<void> {
  const taken = await Promise.all(
    state.checkouts.map((checkout) =>
      release.ports.releaseTrees.take(checkout, checkout.head, release.call),
    ),
  );
  for (const entry of taken)
    if (entry.kind === PortResultKind.Ok) release.trees.push(entry.value);
  for (const entry of taken) {
    if (entry.kind === PortResultKind.Failed) throw portStop(entry);
    release.ports.log.log(TREE_PREPARED, {
      purpose: RELEASE_PURPOSE,
      source: entry.value.source,
    });
  }
}

function treeOf(trees: readonly CommandTree[], bindingId: string): string {
  const tree = trees.find((entry) => entry.binding_id === bindingId);
  assert.ok(tree);
  return tree.directory;
}

function releaseRootOf(
  state: StepsState,
  trees: readonly CommandTree[],
): string {
  const [checkout] = state.checkouts;
  assert.ok(checkout);
  return join(
    dirname(treeOf(trees, checkout.binding_id)),
    relative(dirname(checkout.directory), state.root),
  );
}

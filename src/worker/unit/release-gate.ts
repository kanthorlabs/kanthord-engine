import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import type { TaskContent } from "../../mission/contract.ts";
import { refreshAtRelease, RefreshResult } from "./base-refresh.ts";
import { verificationCommands } from "./evaluation-input.ts";
import { taskRevisionInstruction } from "./judgement.ts";
import { checkoutDetached, cloneLocal } from "./local-git.ts";
import { testedCommitOf, verificationObserver } from "./method-telemetry.ts";
import type { StepsState } from "./steps-implement.ts";
import {
  infrastructureStop,
  runVerificationsWithOutput,
  testedInputOf,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import { CHECKOUTS_DIRECTORY } from "./workspace.ts";

export const RELEASE_DIRECTORY = "release";
const EXIT_SUCCESS = 0;
const NOT_FOUND = -1;
const PARENT = "..";

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
  state: Pick<StepsState, "input" | "revision">,
): TaskContent {
  return {
    id: state.input.claim.node_id,
    filename: state.revision.filename,
    content: state.revision.content,
  };
}

export function commandOwners(
  state: Pick<StepsState, "input" | "revision">,
): TaskContent[] {
  const node = nodeUnitOf(state);
  return [
    ...state.revision.content.verifications.map(() => node),
    ...state.revision.tasks.flatMap((task) =>
      task.content.verifications.map(() => task),
    ),
  ];
}

export async function releaseGate(state: StepsState): Promise<ReleaseGate> {
  if ((await refreshAtRelease(state)) === RefreshResult.BudgetEnd)
    return { kind: ReleaseGateKind.BudgetEnd };
  const commands = verificationCommands(state.revision);
  const owners = commandOwners(state);
  assert.equal(owners.length, commands.length);
  const run = await verifyInReleaseClones(state, commands);
  if (run.outcome === VerificationClass.BudgetEnd) {
    state.agent.budget.wallDeadlineReached();
    return { kind: ReleaseGateKind.BudgetEnd };
  }
  const stop = infrastructureStop(run);
  if (stop) throw stop;
  const passed = verificationPassed(run.verification, commands);
  state.run.log("release verified", {
    commits: state.checkouts.map((checkout) => checkout.head),
    passed,
    exit_codes: run.verification.results.map((result) => result.exit_code),
  });
  if (passed) return { kind: ReleaseGateKind.Passed };
  const owner = owners[firstFailedIndex(run)];
  assert.ok(owner);
  return {
    kind: ReleaseGateKind.Routed,
    unit: owner,
    instruction: taskRevisionInstruction(
      state.input.setup.templates,
      run.verification,
      commands,
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

async function verifyInReleaseClones(
  state: StepsState,
  commands: readonly string[],
): Promise<VerificationRun> {
  const key = state.input.workspaces.nodeKey(state.input.claim.node_id);
  const base = join(key, RELEASE_DIRECTORY);
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    rmSync(base, { recursive: true, force: true });
    const directory = await buildReleaseClones(state, key, base, cleanup);
    const testedInput = testedInputOf(state.checkouts);
    return await runVerificationsWithOutput({
      observe: verificationObserver(
        state.run.spans,
        testedCommitOf(testedInput),
      ),
      directory,
      commands,
      tested_input: testedInput,
      deadline: state.agent.budget.wallDeadline(),
      context: state.run.operationContext,
      env: state.input.env,
      exhausted: () => state.agent.budget.exhausted(),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    cleanup.cancel();
  }
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

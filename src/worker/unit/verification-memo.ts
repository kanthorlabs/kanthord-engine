import assert from "node:assert/strict";
import { canonicalJSON } from "../../kernel/json.ts";
import { treeOf } from "./local-git.ts";
import {
  environmentDigestsOf,
  VerificationContext,
} from "./method-telemetry.ts";
import type { StepsState } from "./steps-implement.ts";
import {
  CommandEnd,
  type CommandRun,
  type Verification,
  VerificationClass,
} from "./verification.ts";

const COMMAND_ABSENT_EXIT = 127;
const NO_COMMANDS = 0;

export type MemoContext = Exclude<
  VerificationContext,
  typeof VerificationContext.Evaluation
>;

export interface MemoEntry {
  result: Verification["results"][number];
  output: string;
  outcome: VerificationClass;
}

export interface MemoScope {
  replay(commands: readonly string[]): MemoEntry[] | null;
  ran(command: string, run: CommandRun, outcome: VerificationClass): void;
}

function storable(
  context: MemoContext,
  run: CommandRun,
  outcome: VerificationClass,
): boolean {
  if (outcome === VerificationClass.Pass) return true;
  return (
    context === VerificationContext.Release &&
    outcome === VerificationClass.CodeFailure &&
    run.end === CommandEnd.Exit &&
    run.result.exit_code !== COMMAND_ABSENT_EXIT
  );
}

export class VerificationMemo {
  private readonly entries = new Map<string, MemoEntry>();

  scope(
    context: MemoContext,
    trees: readonly string[],
    digests: readonly string[],
  ): MemoScope {
    assert.notEqual(context, VerificationContext.Evaluation);
    const keyOf = (command: string) =>
      canonicalJSON({ context, command, trees, digests });
    return {
      replay: (commands) => {
        const replayed: MemoEntry[] = [];
        for (const command of commands) {
          const entry = this.entries.get(keyOf(command));
          if (entry === undefined) return null;
          replayed.push(entry);
          if (entry.outcome !== VerificationClass.Pass) break;
        }
        return replayed.length > NO_COMMANDS ? replayed : null;
      },
      ran: (command, run, outcome) => {
        if (!storable(context, run, outcome)) return;
        this.entries.set(keyOf(command), {
          result: run.result,
          output: run.output,
          outcome,
        });
      },
    };
  }
}

export async function memoScopeOf(
  state: Pick<StepsState, "input" | "run" | "checkouts" | "memo">,
  context: MemoContext,
  commands: readonly string[],
): Promise<MemoScope | undefined> {
  if (commands.length === NO_COMMANDS) return undefined;
  const trees: string[] = [];
  for (const checkout of state.checkouts)
    trees.push(
      await treeOf(
        state.input.env,
        checkout.directory,
        checkout.head,
        state.run.operationContext,
        state.input.claim.expired_at - Date.now(),
      ),
    );
  return state.memo.scope(
    context,
    trees,
    environmentDigestsOf(state.input.setup.repositories),
  );
}

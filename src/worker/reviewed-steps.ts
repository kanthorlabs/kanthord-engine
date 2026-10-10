import type { TaskContent } from "../mission/contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import { diffText } from "./local-git.ts";
import {
  fixInstruction,
  hasBlocker,
  parseRepairedReview,
  reviewInstruction,
  REVIEW_ROUNDS,
  type Finding,
  type Review,
} from "./review.ts";
import { ReplyRepair } from "./judgement.ts";
import {
  runTask,
  taskWork,
  TaskBoundary,
  TaskResultKind,
  type StepsState,
  type TaskResult,
  type TaskRunner,
} from "./steps-objective.ts";

const FIRST_ROUND = 1;
const NO_FINDINGS = 0;
const budgetEndAfterWork: TaskResult = {
  kind: TaskResultKind.BudgetEnd,
  boundary: TaskBoundary.RunPassed,
};

const ReviewStop = {
  BudgetEnd: "budget_end",
  Invalid: "invalid",
} as const;
type ReviewStop = (typeof ReviewStop)[keyof typeof ReviewStop];

export interface ReviewerSessions {
  open(directory: string): Promise<NativeAgent>;
  close(agent: NativeAgent): void;
}

async function reviewTask(
  state: StepsState,
  reviewer: ReviewerSessions,
  task: TaskContent,
  base: string,
  findings: readonly Finding[],
  replies: string | null,
): Promise<Review | ReviewStop> {
  const budget = state.agent.budget;
  const diff = await diffText(
    state.directory,
    base,
    state.head,
    state.run.operationContext,
    budget.remainingMs(),
  );
  const agent = await reviewer.open(state.directory);
  try {
    if (budget.exhausted()) return ReviewStop.BudgetEnd;
    await agent.instruct(
      taskWork(state, task),
      reviewInstruction({
        task,
        nodeCriterion: state.revision.content.criterion,
        diff,
        findings,
        replies,
      }),
    );
    if (budget.exhausted()) return ReviewStop.BudgetEnd;
    const review = await parseRepairedReview(agent, taskWork(state, task));
    if (review === ReplyRepair.BudgetEnd) return ReviewStop.BudgetEnd;
    if (review === ReplyRepair.Invalid) return ReviewStop.Invalid;
    return review;
  } finally {
    reviewer.close(agent);
  }
}

export function reviewedTaskRunner(reviewer: ReviewerSessions): TaskRunner {
  return async (state, task, boundary, instruction) => {
    const budget = state.agent.budget;
    const base = state.head;
    let result = await runTask(state, task, boundary, instruction);
    let findings: readonly Finding[] = [];
    let replies: string | null = null;
    for (let round = FIRST_ROUND; round <= REVIEW_ROUNDS; round++) {
      if (result.kind === TaskResultKind.BudgetEnd) return result;
      if (budget.exhausted()) return budgetEndAfterWork;
      const review = await reviewTask(
        state,
        reviewer,
        task,
        base,
        findings,
        replies,
      );
      if (review === ReviewStop.BudgetEnd) return budgetEndAfterWork;
      if (review === ReviewStop.Invalid) return result;
      findings = review.findings;
      if (findings.length === NO_FINDINGS) return result;
      if (budget.exhausted()) return budgetEndAfterWork;
      await state.agent.instruct(
        taskWork(state, task),
        fixInstruction(findings),
      );
      replies = state.agent.lastText() ?? null;
      const before = state.head;
      result = await runTask(state, task, TaskBoundary.InProgress, null, true);
      if (!hasBlocker(findings) || state.head === before) return result;
    }
    return result;
  };
}

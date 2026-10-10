import { parseAnswer } from "./answer.ts";
import {
  COUNCIL_AGENT,
  planSchema,
  questionsSchema,
  roleAnswerSchema,
  ROLES_BY_COMPLEXITY,
  ROUNDS_BY_COMPLEXITY,
  synthesisSchema,
  triageSchema,
  type CouncilRecord,
  type Round,
  type Triage,
} from "./contract.ts";
import {
  conflictQuestionsMessage,
  planMessage,
  questionsMessage,
  roleMessage,
  synthesisMessage,
  triageMessage,
} from "./messages.ts";

export type Ask = (agentName: string, text: string) => Promise<string>;

const SECOND_ROUND = 2;

async function panel(
  idea: string,
  triage: Triage,
  questions: string[],
  ask: Ask,
): Promise<Round> {
  const roles = ROLES_BY_COMPLEXITY[triage.complexity];
  const answers = await Promise.all(
    roles.map(async (role) =>
      parseAnswer(
        await ask(role, roleMessage(idea, triage, questions)),
        roleAnswerSchema,
        role,
      ),
    ),
  );
  return {
    questions,
    answers: Object.fromEntries(
      roles.map((role, index) => [role, answers[index]!]),
    ),
  };
}

export async function runCouncil(
  idea: string,
  ask: Ask,
  onStep: (step: string) => void = () => {},
): Promise<CouncilRecord> {
  onStep("triage");
  const triage = parseAnswer(
    await ask(COUNCIL_AGENT, triageMessage(idea)),
    triageSchema,
    "triage",
  );
  onStep("questions");
  const { questions } = parseAnswer(
    await ask(COUNCIL_AGENT, questionsMessage(idea, triage)),
    questionsSchema,
    "questions",
  );
  onStep(`round 1: ${ROLES_BY_COMPLEXITY[triage.complexity].join(", ")}`);
  const rounds = [await panel(idea, triage, questions, ask)];
  if (ROUNDS_BY_COMPLEXITY[triage.complexity] >= SECOND_ROUND) {
    onStep("conflict questions");
    const conflicts = parseAnswer(
      await ask(
        COUNCIL_AGENT,
        conflictQuestionsMessage(idea, triage, rounds[0]!),
      ),
      questionsSchema,
      "conflict questions",
    );
    onStep("round 2");
    rounds.push(await panel(idea, triage, conflicts.questions, ask));
  }
  onStep("synthesis");
  const synthesis = parseAnswer(
    await ask(COUNCIL_AGENT, synthesisMessage(idea, triage, rounds)),
    synthesisSchema,
    "synthesis",
  );
  onStep("plan");
  const plan = parseAnswer(
    await ask(COUNCIL_AGENT, planMessage(idea, synthesis)),
    planSchema,
    "plan",
  );
  return { idea, triage, rounds, synthesis, plan };
}

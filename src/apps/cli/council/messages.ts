import type { Round, Synthesis, Triage } from "./contract.ts";

function shape(value: unknown): string {
  return `Answer with one \`\`\`json block of this shape:\n${JSON.stringify(value, null, 2)}`;
}

function context(idea: string, triage?: Triage): string {
  const lines = [`## Idea\n\n${idea}`];
  if (triage)
    lines.push(
      `## Triage\n\nComplexity ${triage.complexity}.\n${triage.reasons.map((reason) => `- ${reason}`).join("\n")}`,
    );
  return lines.join("\n\n");
}

function questionList(questions: readonly string[]): string {
  return `## Questions\n\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`;
}

export function triageMessage(idea: string): string {
  return [
    "Step: triage.",
    context(idea),
    shape({ complexity: "S | M | L", reasons: ["..."] }),
  ].join("\n\n");
}

export function questionsMessage(idea: string, triage: Triage): string {
  return [
    "Step: questions. Ask the open questions that the roles must answer.",
    context(idea, triage),
    shape({ questions: ["..."] }),
  ].join("\n\n");
}

export function roleMessage(
  idea: string,
  triage: Triage,
  questions: readonly string[],
): string {
  return [
    "Step: answer every question from your role.",
    context(idea, triage),
    questionList(questions),
    shape({
      answers: [
        {
          question: "...",
          answer: "...",
          confidence: "low | medium | high",
          assumptions: ["..."],
        },
      ],
    }),
  ].join("\n\n");
}

export function conflictQuestionsMessage(
  idea: string,
  triage: Triage,
  round: Round,
): string {
  return [
    "Step: conflict questions. Ask only about the points where the roles below disagree.",
    context(idea, triage),
    `## Answers\n\n${JSON.stringify(round.answers, null, 2)}`,
    shape({ questions: ["..."] }),
  ].join("\n\n");
}

export function synthesisMessage(
  idea: string,
  triage: Triage,
  rounds: readonly Round[],
): string {
  return [
    "Step: synthesis.",
    context(idea, triage),
    `## Rounds\n\n${JSON.stringify(rounds, null, 2)}`,
    shape({ agreements: ["..."], conflicts: ["..."], direction: "..." }),
  ].join("\n\n");
}

export function planMessage(idea: string, synthesis: Synthesis): string {
  return [
    "Step: plan. Write the direction as plan entries. Use filenames of the form lower-case-words.md. An initiative has no parent. An objective names an initiative as parent. A task names an objective as parent and has no depends_on. Leave bindings empty. Give one reason per filename.",
    context(idea),
    `## Synthesis\n\n${JSON.stringify(synthesis, null, 2)}`,
    shape({
      entries: [
        {
          filename: "example.md",
          kind: "initiative | objective | task",
          parent: "parent.md (absent for an initiative)",
          depends_on: ["other.md (absent for a task)"],
          bindings: [],
          verifications: ["pnpm test"],
          name: "...",
          requirement: "...",
          criterion: "...",
        },
      ],
      reasons: { "example.md": "..." },
    }),
  ].join("\n\n");
}

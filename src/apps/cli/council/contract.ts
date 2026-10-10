import { z } from "zod";
import { importEntrySchema } from "../../../mission/contract.ts";

export const Complexity = { S: "S", M: "M", L: "L" } as const;
export const complexitySchema = z.enum(Complexity);
export type Complexity = z.infer<typeof complexitySchema>;

export const COUNCIL_AGENT = "council@1";
export const RoleAgent = {
  Po: "po@1",
  User: "user@1",
  Designer: "designer@1",
  Architect: "architect@1",
  Security: "security@1",
} as const;
export type RoleAgent = (typeof RoleAgent)[keyof typeof RoleAgent];

export const ROLES_BY_COMPLEXITY: Readonly<
  Record<Complexity, readonly RoleAgent[]>
> = {
  S: [RoleAgent.Po, RoleAgent.User],
  M: [RoleAgent.Po, RoleAgent.User, RoleAgent.Designer, RoleAgent.Architect],
  L: [
    RoleAgent.Po,
    RoleAgent.User,
    RoleAgent.Designer,
    RoleAgent.Architect,
    RoleAgent.Security,
  ],
};
export const ROUNDS_BY_COMPLEXITY: Readonly<Record<Complexity, number>> = {
  S: 1,
  M: 1,
  L: 2,
};
export const ALL_AGENTS: readonly string[] = [
  COUNCIL_AGENT,
  ...ROLES_BY_COMPLEXITY.L,
];

export const CouncilErrorCode = {
  TokenRequired: "cli.council.token_required",
  AgentNotEnabled: "cli.council.agent_not_enabled",
  OutputDirectoryNotEmpty: "cli.council.output_directory_not_empty",
  AgentSessionFailed: "cli.council.agent_session_failed",
  AnswerInvalid: "cli.council.answer_invalid",
  PlanFileInvalid: "cli.council.plan_file_invalid",
} as const;

export const triageSchema = z.strictObject({
  complexity: complexitySchema,
  reasons: z.array(z.string().min(1)).min(1),
});
export type Triage = z.infer<typeof triageSchema>;

export const questionsSchema = z.strictObject({
  questions: z.array(z.string().min(1)).min(1),
});
export type Questions = z.infer<typeof questionsSchema>;

export const roleAnswerSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        question: z.string().min(1),
        answer: z.string().min(1),
        confidence: z.enum(["low", "medium", "high"]),
        assumptions: z.array(z.string().min(1)),
      }),
    )
    .min(1),
});
export type RoleAnswer = z.infer<typeof roleAnswerSchema>;

export const synthesisSchema = z.strictObject({
  agreements: z.array(z.string().min(1)),
  conflicts: z.array(z.string().min(1)),
  direction: z.string().min(1),
});
export type Synthesis = z.infer<typeof synthesisSchema>;

export const planEntrySchema = importEntrySchema
  .omit({ id: true })
  .extend({ bindings: z.array(z.string()).length(0) });
export type PlanEntry = z.infer<typeof planEntrySchema>;

export const planSchema = z.strictObject({
  entries: z.array(planEntrySchema).min(1),
  reasons: z.record(z.string(), z.string().min(1)),
});
export type Plan = z.infer<typeof planSchema>;

export interface Round {
  questions: string[];
  answers: Partial<Record<RoleAgent, RoleAnswer>>;
}

export interface CouncilRecord {
  idea: string;
  triage: Triage;
  rounds: Round[];
  synthesis: Synthesis;
  plan: Plan;
}

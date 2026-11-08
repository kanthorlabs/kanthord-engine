import { z } from "zod";

export const ExternalLinkKind = {
  GitHubIssue: "github_issue",
} as const;
const GITHUB_CONVERSATION_IDENTITY_PATTERN =
  /^conversation:github:[^/\s:]+\/[^/\s:]+$/;
export const externalLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(ExternalLinkKind.GitHubIssue),
    resource_identity: z.string().regex(GITHUB_CONVERSATION_IDENTITY_PATTERN),
    number: z.number().int().positive(),
  }),
]);
export type ExternalLink = z.infer<typeof externalLinkSchema>;

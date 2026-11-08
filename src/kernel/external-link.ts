import { z } from "zod";

export const ExternalLinkKind = {
  GitHubIssue: "github_issue",
  JiraIssue: "jira_issue",
} as const;
const GITHUB_CONVERSATION_IDENTITY_PATTERN =
  /^conversation:github:[^/\s:]+\/[^/\s:]+$/;
const JIRA_CONVERSATION_IDENTITY_PATTERN =
  /^conversation:jira:[a-z0-9][a-z0-9-]*\.atlassian\.net\/[A-Z][A-Z0-9_]{1,9}$/;
const JIRA_ISSUE_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const JIRA_KEY_SEPARATOR = "-";
const IDENTITY_KEY_SEPARATOR = "/";

function isKeyOfIdentity(identity: string, key: string): boolean {
  const projectKey = identity.slice(
    identity.lastIndexOf(IDENTITY_KEY_SEPARATOR) + 1,
  );
  const prefix = `${projectKey}${JIRA_KEY_SEPARATOR}`;
  return (
    key.startsWith(prefix) &&
    JIRA_ISSUE_NUMBER_PATTERN.test(key.slice(prefix.length))
  );
}

export const externalLinkSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(ExternalLinkKind.GitHubIssue),
    resource_identity: z.string().regex(GITHUB_CONVERSATION_IDENTITY_PATTERN),
    number: z.number().int().positive(),
  }),
  z
    .strictObject({
      kind: z.literal(ExternalLinkKind.JiraIssue),
      resource_identity: z.string().regex(JIRA_CONVERSATION_IDENTITY_PATTERN),
      key: z.string(),
    })
    .refine((link) => isKeyOfIdentity(link.resource_identity, link.key), {
      path: ["key"],
    }),
]);
export type ExternalLink = z.infer<typeof externalLinkSchema>;

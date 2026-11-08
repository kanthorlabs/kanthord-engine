export const JIRA_GATEWAY_ORIGIN = "https://api.atlassian.com/ex/jira";
export const JIRA_MYSELF_PATH = "/rest/api/3/myself";

export function jiraApiUrl(cloudId: string, path: string): string {
  return `${JIRA_GATEWAY_ORIGIN}/${cloudId}${path}`;
}

export function jiraBasicAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

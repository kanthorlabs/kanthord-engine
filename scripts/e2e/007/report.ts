import type { E2eEnv } from "../env.ts";
import { scenarios, type ScenarioId } from "./index.ts";

export type ScenarioOutcome = Readonly<{
  id: ScenarioId;
  passed: boolean;
  detail: string;
}>;

export type GateSafety = Readonly<{
  baseOidBefore: string;
  baseOidAfter: string;
  leaked: readonly string[];
}>;

const NOT_COVERED_BY_ONE_REMOTE = [
  "a read-only credential that fetches successfully is refused by the preflight (proved against the EPIC 005 http fixture)",
  "a plain http url is accepted on a loopback host and refused elsewhere (github.com serves no plain http)",
  "a url carrying a password in its userinfo is refused while one carrying only a username is not",
] as const;

function declarationOf(id: ScenarioId) {
  const declaration = scenarios.find((candidate) => candidate.id === id);
  if (declaration === undefined) {
    throw new Error(`no scenario declaration for ${id}`);
  }
  return declaration;
}

export function renderReport(
  env: E2eEnv,
  outcomes: readonly ScenarioOutcome[],
  safety?: GateSafety,
): string {
  const lines: string[] = [];
  lines[lines.length] =
    `# kanthord end-to-end gate — 007-repository-registration`;
  lines[lines.length] = ``;
  lines[lines.length] = `- run id: \`${env.runId}\``;
  lines[lines.length] = `- repository: \`${env.ghRepo}\``;
  lines[lines.length] = `- base branch: \`${env.ghBaseBranch}\``;
  lines[lines.length] = ``;
  lines[lines.length] = `| id | story | goal | outcome |`;
  lines[lines.length] = `| --- | --- | --- | --- |`;
  for (const outcome of outcomes) {
    const declaration = declarationOf(outcome.id);
    lines[lines.length] =
      `| ${outcome.id} | ${declaration.story} | ${declaration.goal} | ${
        outcome.passed ? "pass" : `FAIL (${outcome.detail})`
      } |`;
  }
  lines[lines.length] = ``;
  if (safety !== undefined) {
    lines[lines.length] = `## Safety`;
    lines[lines.length] = ``;
    lines[lines.length] = `- base oid before: \`${safety.baseOidBefore}\``;
    lines[lines.length] = `- base oid after: \`${safety.baseOidAfter}\``;
    lines[lines.length] = `- leaked refs: ${
      safety.leaked.length === 0 ? "none" : safety.leaked.join(", ")
    }`;
    lines[lines.length] = ``;
  }
  lines[lines.length] = `## Not covered by one real remote`;
  lines[lines.length] = ``;
  for (const line of NOT_COVERED_BY_ONE_REMOTE) {
    lines[lines.length] = `- ${line}`;
  }
  lines[lines.length] = ``;
  return lines.join("\n");
}

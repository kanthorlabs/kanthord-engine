import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODING_PROMPT,
  RE_AGENT_PROMPT,
  RE_ROLE_PROMPT,
  SWE_AGENT_PROMPT,
  SWE_ROLE_PROMPT,
} from "./prompt-assets.ts";

function sectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = text.split(/^(## .+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim();
    const body = (parts[i + 1] ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
    sections.set(heading, body);
  }
  return sections;
}

function sharedCodingSections(agentText: string): string {
  const sections = sectionsOf(agentText);
  const principles = sections.get("## Code principles") ?? "";
  const code = sections.get("## Code") ?? "";
  const tests = sections.get("## Tests") ?? "";
  return [
    `## Code principles\n\n${principles}`,
    `## Code\n\n${code}`,
    `## Tests\n\n${tests}`,
  ].join("\n\n");
}

test("coding.md equals the three shared sections of swe@1.md and re@1.md", () => {
  const fromSwe = sharedCodingSections(SWE_AGENT_PROMPT);
  const fromRe = sharedCodingSections(RE_AGENT_PROMPT);
  assert.equal(fromSwe, fromRe);
  assert.equal(CODING_PROMPT.trim(), fromSwe.trim());
});

test("role/swe@1.md equals swe@1.md less the shared sections and the protocol text", () => {
  const sweRoleText = SWE_ROLE_PROMPT;
  assert.ok(!sweRoleText.includes("worker"), "Role must not mention 'worker'");
  assert.ok(
    !sweRoleText.includes("node branch"),
    "Role must not mention 'node branch'",
  );
  assert.ok(!sweRoleText.includes("gate"), "Role must not mention 'gate'");
  const sweRoleSections = sectionsOf(sweRoleText);
  assert.ok(sweRoleSections.has("## Role"), "role/swe@1.md must have ## Role");
  assert.ok(
    sweRoleSections.has("## Execution"),
    "role/swe@1.md must have ## Execution",
  );
  assert.ok(
    sweRoleSections.has("## Findings"),
    "role/swe@1.md must have ## Findings",
  );
  assert.ok(
    !sweRoleSections.has("## Code principles"),
    "role/swe@1.md must not have ## Code principles",
  );
  assert.ok(
    !sweRoleSections.has("## Code"),
    "role/swe@1.md must not have ## Code",
  );
  assert.ok(
    !sweRoleSections.has("## Tests"),
    "role/swe@1.md must not have ## Tests",
  );
});

test("role/re@1.md equals re@1.md Role and Judgement items 1 to 7", () => {
  const reRoleText = RE_ROLE_PROMPT;
  assert.ok(!reRoleText.includes("worker"), "Role must not mention 'worker'");
  assert.ok(
    !reRoleText.includes("node branch"),
    "Role must not mention 'node branch'",
  );
  assert.ok(!reRoleText.includes("gate"), "Role must not mention 'gate'");
  const reRoleSections = sectionsOf(reRoleText);
  assert.ok(reRoleSections.has("## Role"), "role/re@1.md must have ## Role");
  assert.ok(
    reRoleSections.has("## Judgement"),
    "role/re@1.md must have ## Judgement",
  );
  assert.ok(
    !reRoleSections.has("## Findings"),
    "role/re@1.md must not have ## Findings",
  );
  assert.ok(
    !reRoleSections.has("## Code principles"),
    "role/re@1.md must not have ## Code principles",
  );
  const judgement = reRoleSections.get("## Judgement") ?? "";
  const items = judgement.match(/^\d+\./gm) ?? [];
  const JUDGEMENT_ITEM_COUNT = 7;
  assert.equal(
    items.length,
    JUDGEMENT_ITEM_COUNT,
    "role/re@1.md Judgement must have exactly 7 items",
  );
});

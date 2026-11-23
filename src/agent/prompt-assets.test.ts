import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODING_PROMPT,
  RE_AGENT_PROMPT,
  RE_ROLE_PROMPT,
  SWE_AGENT_PROMPT,
  SWE_ROLE_PROMPT,
} from "./prompt-assets.ts";

const FORBIDDEN_ROLE_WORDS = /\b(worker|node branch|gate)\b/i;
const LAST_RE_JUDGEMENT_ITEM = 7;
const EXECUTION_HEADING = "## Execution";
const JUDGEMENT_HEADING = "## Judgement";

function sectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of text.split(/^(?=## )/m)) {
    sections.set(part.slice(0, part.indexOf("\n")), part);
  }
  return sections;
}

function joinSections(
  text: string,
  headings: readonly string[],
  edit: (heading: string, section: string) => string = (_, section) => section,
): string {
  const sections = sectionsOf(text);
  const parts = headings.map((heading) => {
    const section = sections.get(heading);
    assert.ok(section, `missing section ${heading}`);
    return edit(heading, section);
  });
  return parts.join("").replace(/\n+$/, "\n");
}

function replaceOnce(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `missing protocol text ${from}`);
  return text.replace(from, to);
}

function withoutProtocolText(heading: string, section: string): string {
  if (heading !== EXECUTION_HEADING) return section;
  const withoutVerifications = replaceOnce(
    section,
    " The worker runs the verifications after the turn.",
    "",
  );
  return replaceOnce(
    withoutVerifications,
    "into the node branch. The worker merges the base branch itself.",
    "into the branch of the workspace.",
  );
}

function judgementItemsOneToSeven(heading: string, section: string): string {
  if (heading !== JUDGEMENT_HEADING) return section;
  return section
    .split("\n")
    .filter((line) => {
      const item = /^(\d+)\. /.exec(line);
      return !item || Number(item[1]) <= LAST_RE_JUDGEMENT_ITEM;
    })
    .join("\n");
}

const SHARED_CODING_HEADINGS = ["## Code principles", "## Code", "## Tests"];

test("coding.md equals the three shared sections of swe@1.md and re@1.md", () => {
  assert.equal(
    CODING_PROMPT,
    joinSections(SWE_AGENT_PROMPT, SHARED_CODING_HEADINGS),
  );
  assert.equal(
    CODING_PROMPT,
    joinSections(RE_AGENT_PROMPT, SHARED_CODING_HEADINGS),
  );
});

test("role/swe@1.md equals swe@1.md less the shared sections and the protocol text", () => {
  assert.equal(
    SWE_ROLE_PROMPT,
    joinSections(
      SWE_AGENT_PROMPT,
      ["## Role", EXECUTION_HEADING, "## Findings"],
      withoutProtocolText,
    ),
  );
});

test("role/re@1.md equals re@1.md Role and Judgement items 1 to 7", () => {
  assert.equal(
    RE_ROLE_PROMPT,
    joinSections(
      RE_AGENT_PROMPT,
      ["## Role", JUDGEMENT_HEADING],
      judgementItemsOneToSeven,
    ),
  );
});

test("no Role holds the words worker, node branch or gate", () => {
  for (const role of [SWE_ROLE_PROMPT, RE_ROLE_PROMPT])
    assert.doesNotMatch(role, FORBIDDEN_ROLE_WORDS);
});

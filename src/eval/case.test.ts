import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  caseSchema,
  type CaseSource,
  EVAL_DIRECTORY,
  loadSuite,
  parseCase,
} from "./case.ts";

const PLACEHOLDER_UNKNOWN = "eval.case.placeholder_unknown";
const FIXTURE_FILE = "alpha.json";
const RETRIES = "retries";
const DEFAULT_RETRIES = 2;
const NO_ITEMS = 0;
const ASSET_FILE = "report.txt";
const FIXTURE = JSON.stringify({
  entries: [
    {
      filename: "build-1.md",
      intent: "implement",
      name: "Build",
      requirement: "Build it.",
      criterion: "It builds.",
      verifications: ["pnpm test"],
      bindings: [],
      tags: [],
      depends_on: [],
    },
  ],
});

function caseText(overrides: { turn?: string; seed?: string } = {}): string {
  return [
    "id: sample",
    "turns:",
    `  - human: "${overrides.turn ?? "Look at {{alpha.node.build-1.md}}."}"`,
    "fixtures:",
    `  alpha: ${FIXTURE_FILE}`,
    "checks:",
    "  max_tool_calls: 3",
    overrides.seed ?? "",
  ].join("\n");
}

const EVIDENCE_SEED = [
  "seed:",
  "  - step: evidence",
  '    node: "{{alpha.node.build-1.md}}"',
  "    attempt: 1",
  "    assets:",
  "      - media_type: text/plain",
  `        file: ${ASSET_FILE}`,
].join("\n");

function source(text: string, files: Record<string, string> = {}): CaseSource {
  const stored: Record<string, string> = {
    [FIXTURE_FILE]: FIXTURE,
    [ASSET_FILE]: "asset",
    ...files,
  };
  return {
    id: "sample",
    text,
    readFile: (name) => Buffer.from(stored[name]!),
  };
}

test("security: argument guard - a placeholder with an unknown fixture key or filename fails the parse", () => {
  for (const turn of [
    "Look at {{beta.node.build-1.md}}.",
    "Look at {{alpha.node.missing-1.md}}.",
    "Look at {{beta.project_id}}.",
  ])
    assert.throws(() => parseCase(source(caseText({ turn }))), {
      code: PLACEHOLDER_UNKNOWN,
    });
  assert.throws(
    () =>
      parseCase(
        source(caseText({ seed: EVIDENCE_SEED }), {
          [ASSET_FILE]: "See {{beta.node.build-1.md}}.",
        }),
      ),
    { code: PLACEHOLDER_UNKNOWN },
  );
  assert.ok(parseCase(source(caseText())));
});

test("invariant guard: verdict - case_digest is stable under key order and changes with the fixture, the asset or the seed", () => {
  const base = parseCase(source(caseText({ seed: EVIDENCE_SEED })));
  const reordered = [
    "checks:",
    "  max_tool_calls: 3",
    "fixtures:",
    `  alpha: ${FIXTURE_FILE}`,
    "turns:",
    '  - human: "Look at {{alpha.node.build-1.md}}."',
    "id: sample",
    EVIDENCE_SEED,
  ].join("\n");
  assert.equal(parseCase(source(reordered)).case_digest, base.case_digest);
  const changed = [
    parseCase(
      source(caseText({ seed: EVIDENCE_SEED }), {
        [FIXTURE_FILE]: `${FIXTURE}\n`,
      }),
    ),
    parseCase(
      source(caseText({ seed: EVIDENCE_SEED }), { [ASSET_FILE]: "asset!" }),
    ),
    parseCase(
      source(
        caseText({ seed: EVIDENCE_SEED.replace("attempt: 1", "attempt: 2") }),
      ),
    ),
  ];
  for (const variant of changed)
    assert.notEqual(variant.case_digest, base.case_digest);
  const extended = caseSchema.extend({
    [RETRIES]: z.int().default(DEFAULT_RETRIES),
  });
  const plain = parseCase(source(caseText()));
  const withDefault = parseCase(source(caseText()), extended);
  assert.equal(Reflect.get(withDefault, RETRIES), DEFAULT_RETRIES);
  assert.equal(withDefault.case_digest, plain.case_digest);
  const explicit = parseCase(
    source(`${caseText()}\n${RETRIES}: ${DEFAULT_RETRIES}`),
    extended,
  );
  assert.notEqual(explicit.case_digest, plain.case_digest);
});

test("security: argument guard - an unknown key at the top level, in checks or in a seed step fails the parse", () => {
  const unknownKeys = [
    `${caseText()}\nunknown_key: 1`,
    caseText().replace(
      "  max_tool_calls: 3",
      "  max_tool_calls: 3\n  unknown_key: 1",
    ),
    caseText({
      seed: `${EVIDENCE_SEED}\n    unknown_key: 1`,
    }),
  ];
  for (const text of unknownKeys)
    assert.throws(() => parseCase(source(text)), z.ZodError);
  assert.ok(parseCase(source(caseText({ seed: EVIDENCE_SEED }))));
});

test("security: argument guard - every case file under eval parses with its fixture and asset files", () => {
  assert.ok(existsSync(EVAL_DIRECTORY));
  const agents = readdirSync(EVAL_DIRECTORY).filter((name) =>
    statSync(join(EVAL_DIRECTORY, name)).isDirectory(),
  );
  assert.notEqual(agents.length, NO_ITEMS);
  for (const agent of agents)
    assert.notEqual(loadSuite(agent, []).length, NO_ITEMS);
});

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import type { Command } from "commander";
import { createProgram } from "./index.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { storageOperations } from "../../storage/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { missionOperations } from "../../mission/contract.ts";

const PAGE_INVENTORIES = {
  llm: "## Command inventory",
  repository: "## Command inventory",
  storage: "## Command inventory",
  agent: "## Command inventory",
  project: "## Command inventory and synopsis",
  mission: "## Target command inventory and synopsis",
  scheduler: "## Command inventory and operation mapping",
  worker: "## Command inventory",
  gateway: "## Complete command table",
  other: "## Command inventory",
};
const SYNOPSIS_PREFIX = /Synopsis after `kanthord ([^`]+)`/;
const EXEMPT_LEAVES = new Map([
  ["mission evidence upload", "External-harness phase owns the CLI helper"],
  ["mission graph get", "No ERD1 or ERD2 implementation plan"],
  ["mission criterion list", "No ERD1 or ERD2 implementation plan"],
  ["agent list", "Documented future read with no ERD2 implementation plan"],
  [
    "scheduler eligibility get",
    "Documented future read with no ERD2 implementation plan",
  ],
]);
const LATER_GROUPS = { intake: "ERD 3", tracking: "ERD 4" };
const API_ONLY_OPERATIONS = [
  "gateway.liveness",
  "gateway.healthcheck",
  "gateway.openapi",
  "gateway.openapiFile",
  "worker.credential",
  "worker.action.request",
  "worker.execution.setup.get",
  "mission.evidence.asset.complete",
  "mission.evidence.request",
];
const TOP_LEVEL_NAMES = new Set([
  "config",
  "serve",
  "jwt",
  "project",
  "mission",
  "scheduler",
  "intake",
  "worker",
  "tracking",
  "gateway",
  "llm",
  "repository",
  "storage",
  "agent",
]);
const OTHER_PAGE = "other";
const NO_ITEMS = 0;
const DOCUMENTED_COUNT = 146;
const TOP_LEVEL_DEPTH = 1;
const INTAKE_GROUP = "intake";
const TRACKING_GROUP = "tracking";
const IMPLEMENTED_COUNT = 141;
const OPERATION_COUNT = 142;
const PAGE_COUNTS = {
  llm: 14,
  repository: 11,
  storage: 10,
  agent: 15,
  project: 14,
  mission: 56,
  scheduler: 8,
  worker: 9,
  gateway: 2,
  other: 7,
};
type Documented = { path: string; operations: string[] };

function inventory(group: string, heading: string): Documented[] {
  const text = readFileSync(
    new URL(`../../../docs/cli/${group}.md`, import.meta.url),
    "utf8",
  );
  const start = text.indexOf(`${heading}\n`);
  assert.ok(start >= NO_ITEMS, `${group}: missing ${heading}`);
  const end = text.indexOf("\n## ", start + heading.length);
  const lines = text.slice(start, end < NO_ITEMS ? undefined : end).split("\n");
  assert.ok(lines.length);
  let prefix = group;
  return lines.flatMap((line, index) => {
    if (lines[index + 1]?.startsWith("| -"))
      prefix = SYNOPSIS_PREFIX.exec(line)?.[1] ?? group;
    if (line.startsWith("| -") || lines[index + 1]?.startsWith("| -"))
      return [];
    if (!line.startsWith("|") && !/^\d+\. `kanthord /.test(line)) return [];
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    const synopsis =
      spans[0]?.replace(
        new RegExp(`^kanthord ${group === OTHER_PAGE ? "" : `${prefix} `}`),
        "",
      ) ?? "";
    const tokens = synopsis.split(/\s+/);
    const stop = tokens.findIndex((token) => !/^[a-z][a-z-]*$/.test(token));
    const leaf = tokens.slice(0, stop < NO_ITEMS ? undefined : stop).join(" ");
    if (!leaf) return [];
    return [
      {
        path: group === OTHER_PAGE ? leaf : `${prefix} ${leaf}`,
        operations: spans.filter((span) =>
          /^(gateway|llm|repository|storage|agent|worker|scheduler|project|mission)\.[A-Za-z_.]+$/.test(
            span,
          ),
        ),
      },
    ];
  });
}

function programLeaves(program: Command): string[] {
  const pending = program.commands.map((command) => ({
    command,
    path: command.name(),
    depth: 1,
  }));
  const leaves: string[] = [];
  const MAX_COMMANDS = 300;
  for (let index = 0; index < pending.length && index < MAX_COMMANDS; index++) {
    const { command, path, depth } = pending[index]!;
    assert.ok(depth <= MAX_COMMANDS);
    if (
      command.registeredArguments.length > NO_ITEMS ||
      (depth > TOP_LEVEL_DEPTH && command.commands.length === NO_ITEMS)
    )
      leaves.push(path);
    pending.push(
      ...command.commands.map((child) => ({
        command: child,
        path: `${path} ${child.name()}`,
        depth: depth + 1,
      })),
    );
  }
  assert.ok(pending.length < MAX_COMMANDS);
  return leaves.sort();
}

test("documented ERD2 CLI leaves and API-only operations exactly cover the dispatcher and contracts", () => {
  const rows = Object.entries(PAGE_INVENTORIES).flatMap(([group, heading]) => {
    const rows = inventory(group, heading);
    assert.equal(
      new Set(rows.map((row) => row.path)).size,
      PAGE_COUNTS[group as keyof typeof PAGE_COUNTS],
      group,
    );
    return rows;
  });
  const documented = new Set(rows.map((row) => row.path));
  assert.equal(documented.size, DOCUMENTED_COUNT);
  const program = createProgram();
  const leaves = programLeaves(program);
  assert.equal(leaves.length, IMPLEMENTED_COUNT);
  assert.deepEqual(
    leaves,
    [...documented].filter((path) => !EXEMPT_LEAVES.has(path)).sort(),
  );
  for (const [path, reason] of EXEMPT_LEAVES) {
    assert.ok(reason);
    assert.ok(documented.has(path));
    assert.ok(!leaves.includes(path));
  }
  for (const [group, phase] of Object.entries(LATER_GROUPS)) {
    assert.ok(phase);
    assert.ok(
      existsSync(new URL(`../../../docs/cli/${group}.md`, import.meta.url)),
    );
  }
  assert.equal(
    program.commands.find((command) => command.name() === INTAKE_GROUP),
    undefined,
  );
  assert.deepEqual(
    program.commands.find((command) => command.name() === TRACKING_GROUP)
      ?.commands,
    [],
  );
  assert.ok(
    program.commands.every((command) => TOP_LEVEL_NAMES.has(command.name())),
  );
  const documentedOperations = new Set(
    rows
      .filter((row) => !EXEMPT_LEAVES.has(row.path))
      .flatMap((row) => row.operations),
  );
  assert.ok(API_ONLY_OPERATIONS.every((id) => !documentedOperations.has(id)));
  const expected = [
    gatewayOperations,
    llmOperations,
    repositoryOperations,
    storageOperations,
    agentOperations,
    workerOperations,
    schedulerOperations,
    projectOperations,
    missionOperations,
  ]
    .flatMap((operations) => Object.values(operations).map(({ id }) => id))
    .sort();
  assert.equal(expected.length, OPERATION_COUNT);
  assert.deepEqual(
    [...documentedOperations, ...API_ONLY_OPERATIONS].sort(),
    expected,
  );
});

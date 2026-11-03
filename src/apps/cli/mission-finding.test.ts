import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { HttpMethod } from "../../kernel/http.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { isString } from "../../kernel/values.ts";
import { addExecutionCommands } from "./mission-execution.ts";
import { addFindingCommands } from "./mission-finding.ts";

const ENDPOINT = "http://localhost:31415";

function program(): Command {
  const command = new Command("mission")
    .option("--endpoint <url>", "endpoint", ENDPOINT)
    .option("--token <token>", "token", "human-token");
  command.exitOverride();
  addFindingCommands(command);
  addExecutionCommands(command);
  return command;
}

function capture(t: TestContext) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init: RequestInit) => {
      requests.push({
        method: init.method ?? HttpMethod.Get,
        url: String(url),
        body: isString(init.body) ? JSON.parse(init.body) : null,
      });
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/review-round"))
        return Response.json({
          round: 1,
          final: false,
          review_base: null,
          findings: [],
        });
      if (path.endsWith("/decide"))
        return Response.json(decidedFinding(path.split("/").at(-2)!));
      return Response.json({ items: [], next_cursor: null });
    },
  );
  t.mock.method(process.stdout, "write", () => true);
  return requests;
}

function decidedFinding(id: string) {
  return {
    id,
    node_id: createIdentity("node"),
    attempt: 1,
    round: 1,
    assessment_id: createIdentity("assessment"),
    source: "reviewer",
    label: "S1",
    kind: "suggestion",
    action: "yes",
    task_id: null,
    ground: null,
    name: "Name",
    description: "Description",
    fix: "Fix",
    why: "Why",
    route: "report",
    status: "open",
    fixed_assessment_id: null,
    cause_owner: null,
    created_by: null,
    created_at: 1,
    decision: "dismissed",
    decision_reason: "No defect",
    decided_by: { kind: "human", account: "ulrich", name: "Ulrich" },
    decided_at: 2,
  };
}

function coded(code: string) {
  return (error: unknown) => error instanceof Diagnostic && error.code === code;
}

test("each finding leaf refuses a malformed argument with its local code", async (t) => {
  capture(t);
  const node = createIdentity("node");
  for (const [args, code] of [
    [
      ["finding", "list", "node_bad"],
      "cli.mission.finding.list.invalid_node_id",
    ],
    [
      ["finding", "list", node, "--attempt", "-1"],
      "cli.mission.finding.list.invalid_attempt",
    ],
    [
      ["finding", "list", node, "--round", "0"],
      "cli.mission.finding.list.invalid_round",
    ],
    [
      ["finding", "get", "finding_bad"],
      "cli.mission.finding.get.invalid_finding_id",
    ],
    [
      ["finding", "undecided", "list", "project_bad"],
      "cli.mission.finding.undecided.list.invalid_project_id",
    ],
    [
      ["finding", "decide", "finding_bad", "--file", "body.json"],
      "cli.mission.finding.decide.invalid_finding_id",
    ],
    [
      ["finding", "create", "node_bad", "--file", "body.json"],
      "cli.mission.finding.create.invalid_node_id",
    ],
    [
      ["finding", "update", "finding_bad", "--file", "body.json"],
      "cli.mission.finding.update.invalid_finding_id",
    ],
    [
      ["execution", "review-round", "get", "execution_bad"],
      "cli.mission.execution.review_round.get.invalid_execution_id",
    ],
  ] as const) {
    await assert.rejects(
      program().parseAsync([...args], { from: "user" }),
      coded(code),
    );
  }
});

test("the finding reads and the decide call the routes of their operations", async (t) => {
  const requests = capture(t);
  const node = createIdentity("node");
  const finding = createIdentity("finding");
  const project = createIdentity("project");
  const execution = createIdentity("execution");
  await program().parseAsync(
    ["finding", "list", node, "--attempt", "1", "--round", "2"],
    { from: "user" },
  );
  await program().parseAsync(["finding", "undecided", "list", project], {
    from: "user",
  });
  await program().parseAsync(["execution", "review-round", "get", execution], {
    from: "user",
  });
  const directory = mkdtempSync(join(tmpdir(), "finding-decide-"));
  const file = join(directory, "body.json");
  writeFileSync(
    file,
    JSON.stringify({ decision: "dismissed", decision_reason: "No defect" }),
  );
  await program().parseAsync(["finding", "decide", finding, "--file", file], {
    from: "user",
  });
  assert.deepEqual(
    requests.map((request) => [
      request.method,
      new URL(request.url).pathname,
      new URL(request.url).search,
    ]),
    [
      [
        HttpMethod.Get,
        `/api/mission/node/${node}/finding`,
        "?limit=100&attempt=1&round=2",
      ],
      [
        HttpMethod.Get,
        `/api/mission/project/${project}/undecided-finding`,
        "?limit=100",
      ],
      [HttpMethod.Get, `/api/mission/execution/${execution}/review-round`, ""],
      [HttpMethod.Post, `/api/mission/finding/${finding}/decide`, ""],
    ],
  );
  assert.deepEqual(requests.at(-1)?.body, {
    decision: "dismissed",
    decision_reason: "No defect",
  });
});

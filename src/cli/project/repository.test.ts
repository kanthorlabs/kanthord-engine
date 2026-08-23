import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerProjectRepository } from "./repository.ts";
import { registerProjectCreate } from "./create.ts";
import { registerProjectList } from "./list.ts";
import { registerProjectShow } from "./show.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";

const PROJECT_VIEW = {
  id: ID,
  name: "kanthord-verify",
  repositories: ["repo_a"],
  updatedAt: 1722800000000,
};

const repo = (id: string, name: string): unknown => ({
  id,
  name,
  remoteUrl: "https://github.com/o/r.git",
  credential: { id: "provider_gh", name: "gh" },
  branch: "main",
  landingRef: "refs/heads/main",
  trackingRef: "refs/remotes/origin/main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  state: "ready",
  landingOid: "a".repeat(40),
  trackingOid: "a".repeat(40),
  fetchedUpstreamOid: "a".repeat(40),
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: 1722800000000,
});

const REPOSITORIES = {
  repositories: [repo("repo_a", "kanthord-verify"), repo("repo_b", "second")],
};

const defaultRespond = (operationId: string): CallResult => {
  if (operationId === "repository.list") {
    return { ok: true, status: 200, body: REPOSITORIES };
  }
  if (operationId === "project.repositories") {
    return { ok: true, status: 200, body: PROJECT_VIEW };
  }
  throw new Error(`unexpected operation: ${operationId}`);
};

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
  } = {},
): {
  program: Command;
  calls: readonly Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[] = [];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      return options.respond !== undefined
        ? options.respond(operationId, body)
        : defaultRespond(operationId);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerProjectRepository({
    program,
    client,
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    fail: () => {
      failCalls += 1;
    },
  });
  return {
    program,
    calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/project/repository.test", () => {
  it("the name resolves: repository.list then project.repositories with the id", async () => {
    const h = harness();
    await run(h.program, [
      "project",
      "repository",
      "--id",
      ID,
      "--repository",
      "kanthord-verify",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["repository.list", "project.repositories"],
    );
    assert.deepEqual(h.calls[1]?.body, { repositories: ["repo_a"] });
    assert.deepEqual(h.calls[1]?.parameters, { id: ID });
    assert.equal(h.failCalls(), 0);
  });

  it("a name matching no repository writes the not-found line and records one call", async () => {
    const h = harness();
    await run(h.program, [
      "project",
      "repository",
      "--id",
      ID,
      "--repository",
      "nope",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 1);
    assert.equal(
      h.stderrText(),
      "kanthord: not-found: no repository named nope\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("two --repository flags send both ids and a 400 too-many-repositories is printed and fails", async () => {
    const h = harness({
      respond: (operationId) =>
        operationId === "project.repositories"
          ? {
              ok: false as const,
              status: 400,
              code: "invalid-request",
              message: "a project may hold at most one repository",
              details: { refusal: "too-many-repositories" },
            }
          : defaultRespond(operationId),
    });
    await run(h.program, [
      "project",
      "repository",
      "--id",
      ID,
      "--repository",
      "kanthord-verify",
      "--repository",
      "second",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: a project may hold at most one repository\n",
    );
    assert.deepEqual(h.calls[1]?.body, { repositories: ["repo_a", "repo_b"] });
  });

  it("no --repository sends { repositories: [] } and skips the resolution call", async () => {
    const h = harness();
    await run(h.program, ["project", "repository", "--id", ID]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["project.repositories"],
    );
    assert.deepEqual(h.calls[0]?.body, { repositories: [] });
    assert.equal(h.failCalls(), 0);
  });

  it("the match on name is exact and case-sensitive", async () => {
    const h = harness({
      respond: (operationId) =>
        operationId === "repository.list"
          ? {
              ok: true as const,
              status: 200,
              body: { repositories: [repo("repo_a", "Kanthord")] },
            }
          : defaultRespond(operationId),
    });
    await run(h.program, [
      "project",
      "repository",
      "--id",
      ID,
      "--repository",
      "kanthord",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 1);
    assert.equal(
      h.stderrText(),
      "kanthord: not-found: no repository named kanthord\n",
    );
  });

  it("two repositories with distinct names resolve to their own ids", async () => {
    const h = harness();
    await run(h.program, [
      "project",
      "repository",
      "--id",
      ID,
      "--repository",
      "kanthord-verify",
      "--repository",
      "second",
    ]);

    assert.equal(h.failCalls(), 0);
    assert.equal(h.stderrText(), "");
    assert.deepEqual(h.calls[1]?.body, { repositories: ["repo_a", "repo_b"] });
    assert.ok(h.stdoutText().startsWith(`kanthord: project ${ID}\n`));
  });

  it("registering all four commands twice yields one project subcommand with four children", () => {
    const program = new Command();
    registerClientOptions(program);
    const client = {
      call: async () => ({ ok: true as const, status: 200, body: {} }),
    };
    const input = {
      program,
      client,
      stdout: () => {},
      stderr: () => {},
      fail: () => {},
    };
    registerProjectCreate(input);
    registerProjectList(input);
    registerProjectShow(input);
    registerProjectRepository(input);
    registerProjectCreate(input);
    registerProjectList(input);
    registerProjectShow(input);
    registerProjectRepository(input);

    const groups = program.commands.filter(
      (command) => command.name() === "project",
    );
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.ok(group !== undefined);
    assert.equal(group.commands.length, 4);
    assert.deepEqual(group.commands.map((command) => command.name()).sort(), [
      "create",
      "list",
      "repository",
      "show",
    ]);
  });
});

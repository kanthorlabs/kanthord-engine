import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerRepositoryShow } from "./show.ts";

const VIEW = {
  id: "repo_01HZY8QF3M4N5P6R7S8T9V0W1X",
  name: "r-gh",
  remoteUrl: "https://github.com/o/r.git",
  credential: { id: "provider_gh", name: "gh" },
  upstreamBranch: "main",
  landingBranch: "main",
  landingRef: "refs/heads/main",
  trackingRef: "refs/remotes/origin/main",
  publishRef: "refs/heads/kanthord-e2e/007/cli",
  publishOnApproval: true,
  state: "ready",
  landingOid: "a".repeat(40),
  trackingOid: "a".repeat(40),
  fetchedUpstreamOid: "a".repeat(40),
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: 1722800000000,
};

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
  } = {},
): {
  program: Command;
  calls: readonly Readonly<{ operationId: string; body: unknown }>[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{ operationId: string; body: unknown }>[] = [];
  const client = {
    call: async (operationId: string, body: unknown): Promise<CallResult> => {
      calls.push({ operationId, body });
      if (options.respond !== undefined) {
        return options.respond(operationId, body);
      }
      return { ok: true as const, status: 200, body: VIEW };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerRepositoryShow({
    program,
    client,
    env: {},
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

const ID = "repo_01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/cli/repository/show.test", () => {
  it("prints the seven named lines in order with empty stderr", async () => {
    const h = harness();
    await run(h.program, ["repository", "show", "--id", ID]);

    assert.equal(
      h.stdoutText(),
      "kanthord: registered r-gh repo_01HZY8QF3M4N5P6R7S8T9V0W1X\n" +
        "kanthord: upstream main\n" +
        "kanthord: landing refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "kanthord: tracking refs/remotes/origin/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "kanthord: publish refs/heads/kanthord-e2e/007/cli\n" +
        "kanthord: state ready\n" +
        "kanthord: credential gh provider_gh\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["repository.show"],
    );
  });

  it("a 404 calls fail once and stdout stays empty", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: `no repository ${ID}`,
        details: undefined,
      }),
    });
    await run(h.program, ["repository", "show", "--id", ID]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.stdoutText(), "");
    assert.equal(h.stderrText(), `kanthord: not-found: no repository ${ID}\n`);
  });

  it("missing --id fails before any request and names the flag", async () => {
    const h = harness();
    await run(h.program, ["repository", "show"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.ok(h.stderrText().startsWith("kanthord: invalid-request: "));
    assert.ok(h.stderrText().includes("--id"), h.stderrText());
    assert.equal(h.stdoutText(), "");
  });
});

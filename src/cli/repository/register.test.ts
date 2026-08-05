import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import type { ConfirmDependencies } from "../confirm.ts";
import { registerRepositoryRegister } from "./register.ts";

const GIT_PROVIDER = {
  id: "provider_gh",
  name: "gh",
  kind: "git",
  projection: {
    transport: "http-basic",
    forge: "github",
    username: "x-access-token",
  },
  setDefaultAt: null,
  updatedAt: 1722800000000,
};

const LLM_PROVIDER = {
  id: "provider_llm",
  name: "llm",
  kind: "llm",
  projection: {
    provider: "anthropic",
    defaultModel: "claude-opus-5",
    baseUrl: null,
  },
  setDefaultAt: null,
  updatedAt: 1722800000000,
};

const VIEW = {
  id: "repo_01HZY8QF3M4N5P6R7S8T9V0W1X",
  name: "r",
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

const defaultRespond = (operationId: string): CallResult => {
  if (operationId === "provider.list") {
    return {
      ok: true,
      status: 200,
      body: { providers: [GIT_PROVIDER, LLM_PROVIDER] },
    };
  }
  if (operationId === "repository.inspect") {
    return {
      ok: true,
      status: 200,
      body: {
        defaultBranch: "main",
        branches: ["main"],
        credential: { reachable: true, refusal: null },
        hostKey: null,
      },
    };
  }
  if (operationId === "repository.register") {
    return { ok: true, status: 200, body: VIEW };
  }
  throw new Error(`unexpected operation: ${operationId}`);
};

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
    confirm?: ConfirmDependencies;
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
      return options.respond !== undefined
        ? options.respond(operationId, body)
        : defaultRespond(operationId);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerRepositoryRegister({
    program,
    client,
    env: {},
    confirm: options.confirm ?? { isTty: false, prompt: async () => "" },
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

const registerCall = (
  h: ReturnType<typeof harness>,
): Readonly<{ operationId: string; body: unknown }> | undefined => {
  return h.calls.find((call) => call.operationId === "repository.register");
};

describe("src/cli/repository/register.test", () => {
  it("resolves --credential to an id and records provider.list, repository.inspect, repository.register in order", async () => {
    const h = harness();
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
      "--publish-ref",
      "refs/heads/kanthord-e2e/007/cli",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["provider.list", "repository.inspect", "repository.register"],
    );
    assert.deepEqual(h.calls[1]?.body, {
      remoteUrl: "https://github.com/o/r.git",
      credentialId: "provider_gh",
    });
    assert.deepEqual(registerCall(h)?.body, {
      name: "r",
      remoteUrl: "https://github.com/o/r.git",
      credentialId: "provider_gh",
      upstreamBranch: "main",
      landingBranch: "main",
      publishRef: "refs/heads/kanthord-e2e/007/cli",
      publishOnApproval: true,
      hostFingerprint: null,
    });
    assert.equal(h.failCalls(), 0);
  });

  it("an unknown --credential fails after only the provider.list call", async () => {
    const h = harness();
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "nope",
      "--upstream",
      "main",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["provider.list"],
    );
    assert.ok(h.stderrText().startsWith("kanthord: not-found:"));
    assert.equal(h.stdoutText(), "");
  });

  it("a --credential of kind llm fails without calling inspect", async () => {
    const h = harness();
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "llm",
      "--upstream",
      "main",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["provider.list"],
    );
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: the credential llm is of kind llm\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("--upstream wins over the prompt", async () => {
    const h = harness({
      confirm: {
        isTty: true,
        prompt: async () => {
          throw new Error("the prompt must not be called");
        },
      },
    });
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);

    assert.equal(h.failCalls(), 0);
    assert.equal(
      (registerCall(h)?.body as { upstreamBranch: string }).upstreamBranch,
      "main",
    );
  });

  it("no --upstream and no terminal refuses and names the flag without calling register", async () => {
    const h = harness({ confirm: { isTty: false, prompt: async () => "" } });
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--publish-ref",
      "refs/heads/kanthord-e2e/007/cli",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(
      h.stderrText(),
      "kanthord: confirmation-required: --upstream is required when there is no terminal to confirm on\n",
    );
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["provider.list", "repository.inspect"],
    );
    assert.equal(registerCall(h), undefined);
  });

  it("an ssh url with no --host-fingerprint and no terminal refuses naming the flag", async () => {
    const h = harness({
      respond: (operationId, body) =>
        operationId === "repository.inspect"
          ? {
              ok: true,
              status: 200,
              body: {
                defaultBranch: "main",
                branches: ["main"],
                credential: { reachable: false, refusal: "host-key-mismatch" },
                hostKey: {
                  algorithm: "ssh-ed25519",
                  fingerprint: "SHA256:" + "A".repeat(43),
                },
              },
            }
          : defaultRespond(operationId),
      confirm: { isTty: false, prompt: async () => "" },
    });
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "ssh://git@github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("--host-fingerprint"), h.stderrText());
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["provider.list", "repository.inspect"],
    );
    assert.equal(registerCall(h), undefined);
  });

  it("an https url needs no --host-fingerprint and records hostFingerprint null", async () => {
    const h = harness({ confirm: { isTty: false, prompt: async () => "" } });
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);

    assert.equal(h.failCalls(), 0);
    assert.equal(
      (registerCall(h)?.body as { hostFingerprint: string | null })
        .hostFingerprint,
      null,
    );
  });

  it("an ssh url with --host-fingerprint registers without a prompt", async () => {
    const h = harness({
      respond: (operationId, body) =>
        operationId === "repository.inspect"
          ? {
              ok: true,
              status: 200,
              body: {
                defaultBranch: "main",
                branches: ["main"],
                credential: { reachable: false, refusal: "host-key-mismatch" },
                hostKey: {
                  algorithm: "ssh-ed25519",
                  fingerprint: "SHA256:" + "A".repeat(43),
                },
              },
            }
          : defaultRespond(operationId),
      confirm: {
        isTty: true,
        prompt: async () => {
          throw new Error("the prompt must not be called");
        },
      },
    });
    const fingerprint = "SHA256:" + "B".repeat(43);
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "ssh://git@github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
      "--host-fingerprint",
      fingerprint,
    ]);

    assert.equal(h.failCalls(), 0);
    assert.equal(
      (registerCall(h)?.body as { hostFingerprint: string }).hostFingerprint,
      fingerprint,
    );
  });

  it("the prompt suggests the inspected default branch", async () => {
    const questions: string[] = [];
    const h = harness({
      respond: (operationId, body) =>
        operationId === "repository.inspect"
          ? {
              ok: true,
              status: 200,
              body: {
                defaultBranch: "trunk",
                branches: ["trunk"],
                credential: { reachable: true, refusal: null },
                hostKey: null,
              },
            }
          : defaultRespond(operationId),
      confirm: {
        isTty: true,
        prompt: async (question) => {
          questions.push(question);
          return "";
        },
      },
    });
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
    ]);

    assert.equal(h.failCalls(), 0);
    assert.equal(
      (registerCall(h)?.body as { upstreamBranch: string }).upstreamBranch,
      "trunk",
    );
    assert.equal(questions.length, 1);
    assert.ok(
      questions[0] !== undefined && questions[0].includes("[trunk]"),
      questions[0],
    );
  });

  it("--landing defaults to the confirmed upstream and --publish-ref to refs/heads/ plus it", async () => {
    const h = harness();
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);

    const body = registerCall(h)?.body as {
      landingBranch: string;
      publishRef: string;
    };
    assert.equal(body.landingBranch, "main");
    assert.equal(body.publishRef, "refs/heads/main");
  });

  it("an explicit --landing overrides only the landing", async () => {
    const h = harness();
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
      "--landing",
      "kanthord/main",
    ]);

    const body = registerCall(h)?.body as {
      landingBranch: string;
      publishRef: string;
    };
    assert.equal(body.landingBranch, "kanthord/main");
    assert.equal(body.publishRef, "refs/heads/main");
  });

  it("--no-publish-on-approval records false and its absence records true", async () => {
    const h1 = harness();
    await run(h1.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
      "--no-publish-on-approval",
    ]);
    assert.equal(
      (registerCall(h1)?.body as { publishOnApproval: boolean })
        .publishOnApproval,
      false,
    );

    const h2 = harness();
    await run(h2.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);
    assert.equal(
      (registerCall(h2)?.body as { publishOnApproval: boolean })
        .publishOnApproval,
      true,
    );
  });

  it("a url naming no supported transport fails before any client call", async () => {
    const h = harness();
    await run(h.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "file:///tmp/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: file:///tmp/r.git names no supported transport\n",
    );
  });

  it("a daemon 409 writes host-key-mismatch and a 422 writes credential-rejected", async () => {
    const h409 = harness({
      respond: (operationId, body) =>
        operationId === "repository.register"
          ? {
              ok: false,
              status: 409,
              code: "host-key-mismatch",
              message: "the host key does not match",
              details: undefined,
            }
          : defaultRespond(operationId),
    });
    await run(h409.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);
    assert.equal(h409.failCalls(), 1);
    assert.equal(
      h409.stderrText(),
      "kanthord: host-key-mismatch: the host key does not match\n",
    );

    const h422 = harness({
      respond: (operationId, body) =>
        operationId === "repository.register"
          ? {
              ok: false,
              status: 422,
              code: "credential-rejected",
              message: "the credential was rejected",
              details: undefined,
            }
          : defaultRespond(operationId),
    });
    await run(h422.program, [
      "repository",
      "register",
      "--name",
      "r",
      "--url",
      "https://github.com/o/r.git",
      "--credential",
      "gh",
      "--upstream",
      "main",
    ]);
    assert.equal(h422.failCalls(), 1);
    assert.equal(
      h422.stderrText(),
      "kanthord: credential-rejected: the credential was rejected\n",
    );
  });

  it("routes on code, never on message: two 400s with different messages both print invalid-request", async () => {
    for (const message of ["the first message", "the second message"]) {
      const h = harness({
        respond: (operationId, body) =>
          operationId === "repository.register"
            ? {
                ok: false,
                status: 400,
                code: "invalid-request",
                message,
                details: undefined,
              }
            : defaultRespond(operationId),
      });
      await run(h.program, [
        "repository",
        "register",
        "--name",
        "r",
        "--url",
        "https://github.com/o/r.git",
        "--credential",
        "gh",
        "--upstream",
        "main",
      ]);
      assert.equal(h.failCalls(), 1);
      assert.ok(h.stderrText().startsWith("kanthord: invalid-request:"));
      assert.ok(h.stderrText().includes(message));
    }
  });
});

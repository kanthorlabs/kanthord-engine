import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerCredentialRegister } from "./register.ts";

const REGISTERED = {
  id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
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
  exitCodes(): readonly number[];
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
      return { ok: true as const, status: 200, body: REGISTERED };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerCredentialRegister({
    program,
    client,
    env: {},
    confirm: { isTty: false, prompt: async () => "" },
    readFile: (path) => readFileSync(path, "utf8"),
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    fail: () => {
      failCalls += 1;
    },
    exit: (code) => {
      exitCalls.push(code);
    },
  });
  return {
    program,
    calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
    exitCodes: () => exitCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

const tempDir = (
  t: { after(fn: () => void): void },
  prefix: string,
): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

describe("src/cli/credential/register.test", () => {
  it("registers an http-basic credential from a token file and prints the three lines", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghp_0123456789abcdef\n");
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "x-access-token",
      "--input-token-file",
      tokenFile,
    ]);

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.operationId, "provider.register");
    assert.deepEqual(h.calls[0]?.body, {
      name: "gh",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "x-access-token",
        token: "ghp_0123456789abcdef",
      },
    });
    assert.equal(
      h.stdoutText(),
      "kanthord: registered gh provider_01HZY8QF3M4N5P6R7S8T9V0W1X\n" +
        "kanthord: transport http-basic\n" +
        "kanthord: forge github\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("a single trailing newline in the token file is trimmed from the recorded token", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghp_token-with-newline\n");
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "x-access-token",
      "--input-token-file",
      tokenFile,
    ]);

    const payload = (h.calls[0]?.body as { payload: { token: string } })
      .payload;
    assert.equal(payload.token, "ghp_token-with-newline");
  });

  it("a token containing an interior newline keeps it", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghp_two\nlines\n");
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "x-access-token",
      "--input-token-file",
      tokenFile,
    ]);

    const payload = (h.calls[0]?.body as { payload: { token: string } })
      .payload;
    assert.equal(payload.token, "ghp_two\nlines");
  });

  it("--kind git with no --transport fails before any request", async () => {
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --transport is required for --kind git\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("missing --name fails before any request and names the flag", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghp_0123456789abcdef\n");
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "x-access-token",
      "--input-token-file",
      tokenFile,
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.ok(h.stderrText().startsWith("kanthord: invalid-request: "));
    assert.ok(h.stderrText().includes("--name"), h.stderrText());
    assert.equal(h.stdoutText(), "");
  });

  it("a flag belonging to another kind fails before any request", async () => {
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "claude",
      "--kind",
      "llm",
      "--transport",
      "http-basic",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.ok(h.stderrText().startsWith("kanthord: invalid-request:"));
    assert.equal(h.stdoutText(), "");
  });

  it("--kind git --transport ssh records only the private key in the payload", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const keyFile = join(dir, "key");
    writeFileSync(
      keyFile,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----\n",
    );
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
      "--transport",
      "ssh",
      "--private-key-file",
      keyFile,
    ]);

    const payload = (h.calls[0]?.body as { payload: Record<string, unknown> })
      .payload;
    assert.deepEqual(payload, {
      transport: "ssh",
      privateKey:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----",
    });
    assert.deepEqual(Object.keys(payload), ["transport", "privateKey"]);
  });

  it("--kind llm records the provider, the api key, the model and a null base url", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const apiKeyFile = join(dir, "api-key");
    writeFileSync(apiKeyFile, "sk-ant-abc123\n");
    const h = harness();
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "anthropic",
      "--kind",
      "llm",
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-5",
      "--api-key-file",
      apiKeyFile,
    ]);

    assert.equal(h.calls.length, 1);
    const body = h.calls[0]?.body as { kind: string; payload: unknown };
    assert.equal(body.kind, "llm");
    assert.deepEqual(body.payload, {
      provider: "anthropic",
      apiKey: "sk-ant-abc123",
      defaultModel: "claude-opus-5",
      baseUrl: null,
    });
  });

  it("a daemon 400 writes the refusal line and fails once with empty stdout", async (t) => {
    const dir = tempDir(t, "kanthord-cli-credential-");
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "ghp_bad\n");
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 400,
        code: "invalid-request",
        message: "the payload does not match the schema of kind git",
        details: undefined,
      }),
    });
    await run(h.program, [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "x-access-token",
      "--input-token-file",
      tokenFile,
    ]);

    assert.deepEqual(h.exitCodes(), [110]);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: the payload does not match the schema of kind git\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("no secret option exists: no --token, --private-key or --api-key flag and the module source names none", async () => {
    const h = harness();
    const credentialCommand = h.program.commands.find(
      (command) => command.name() === "credential",
    );
    assert.ok(credentialCommand, "the credential command exists");
    const registerCommand = credentialCommand.commands.find(
      (command) => command.name() === "register",
    );
    assert.ok(registerCommand, "the register command exists");
    const longs = registerCommand.options
      .map((option) => option.long)
      .filter((long): long is string => long !== undefined);
    for (const forbidden of ["--token", "--private-key", "--api-key"]) {
      assert.equal(longs.includes(forbidden), false, `no ${forbidden} option`);
    }

    const source = readFileSync(resolve(import.meta.dirname, "register.ts"), {
      encoding: "utf8",
    });
    for (const forbidden of ["--token", "--private-key", "--api-key"]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `the module source does not mention ${forbidden}`,
      );
    }
  });
});

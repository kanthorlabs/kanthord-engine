import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import type { SecretFileSink } from "../secret-file.ts";
import { createSecretFile } from "../secret-file.ts";
import { registerActorRotate } from "./rotate.ts";

const BOOTSTRAP_ID = "actor_" + "0".repeat(26);
const ACTOR_ID = "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR";
const SECRET = "xyz-def_ghijklmnopqrstuvwxyzABCDEFGHIJKLMNO";
const TOKEN = `${ACTOR_ID}.${SECRET}`;

const VIEW = {
  id: ACTOR_ID,
  kind: "harness",
  name: "a",
  registeredBy: BOOTSTRAP_ID,
  createdAt: 1722800000000,
  revokedAt: null,
  revokedBy: null,
};

const defaultRespond = (operationId: string): CallResult => {
  if (operationId === "actor.rotate") {
    return { ok: true, status: 200, body: { ...VIEW, token: TOKEN } };
  }
  throw new Error(`unexpected operation: ${operationId}`);
};

const makeRecordingSink = (): {
  sink: SecretFileSink;
  events: () => readonly string[];
  discarded: () => number;
} => {
  let content = "";
  let discarded = 0;
  const events: string[] = [];
  return {
    sink: {
      write: (text: string) => {
        events.push(text);
        content = text;
      },
      discard: () => {
        discarded += 1;
        content = "";
      },
    },
    events: () => events,
    discarded: () => discarded,
  };
};

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
    sink?: SecretFileSink;
  } = {},
): {
  program: Command;
  calls: readonly Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[];
  createdPaths: () => readonly string[];
  sinkEvents: () => readonly string[];
  discardCalls: () => number;
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
      parameters: Readonly<Record<string, string>> | undefined,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      return options.respond !== undefined
        ? options.respond(operationId, body)
        : defaultRespond(operationId);
    },
  };
  const recording = makeRecordingSink();
  const sink = options.sink ?? recording.sink;
  const createdPaths: string[] = [];
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerActorRotate({
    program,
    client,
    createSecretFile: (path: string) => {
      createdPaths.push(path);
      return sink;
    },
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
    createdPaths: () => createdPaths,
    sinkEvents: () => recording.events(),
    discardCalls: () => recording.discarded(),
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

const tempDirs: string[] = [];

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-actor-rotate-"));
  tempDirs.push(directory);
  return directory;
};

after(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("src/cli/actor/rotate.test", () => {
  it("rotates through exactly one actor.rotate call, writes the token to the sink and prints no token", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const h = harness();

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(h.failCalls(), 0);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["actor.rotate"],
    );
    assert.deepEqual(h.calls[0]?.parameters, { id: ACTOR_ID });
    assert.equal(h.calls[0]?.body, undefined);
    assert.deepEqual(h.createdPaths(), [path]);
    assert.deepEqual(h.sinkEvents(), ["", TOKEN]);
    assert.deepEqual(
      h
        .stdoutText()
        .split("\n")
        .filter((line) => line !== ""),
      [ACTOR_ID, `token: [redacted] -> ${path}`],
    );
    assert.equal(h.stdoutText().includes(TOKEN), false);
  });

  it("writes the token to a real sink with mode 0600", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const h = harness({ sink: createSecretFile(path) });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(h.failCalls(), 0);
    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), TOKEN);
  });

  it("an existing path fails before any request and leaves the file unchanged", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    writeFileSync(path, "keep-me", "utf8");
    const h = harness({ sink: createSecretFile(path) });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(h.calls.length, 0);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().startsWith("kanthord: "));
    assert.equal(readFileSync(path, "utf8"), "keep-me");
    assert.equal(h.stdoutText(), "");
  });

  it("a failed request discards the file the command created", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const h = harness({
      sink: createSecretFile(path),
      respond: () => ({
        ok: false,
        status: 400,
        code: "invalid-request",
        message: "the bootstrap actor cannot rotate its token",
        details: undefined,
      }),
    });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(existsSync(path), false);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("invalid-request"));
  });

  it("a failed request records exactly one discard call and no stdout", async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 400,
        code: "invalid-request",
        message: "the bootstrap actor cannot rotate its token",
        details: undefined,
      }),
    });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      "/tmp/token.txt",
    ]);

    assert.equal(h.discardCalls(), 1);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("invalid-request"));
    assert.equal(h.stdoutText(), "");
  });

  it("a throwing client call discards the file the command created and fails", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const h = harness({
      sink: createSecretFile(path),
      respond: () => {
        throw new Error("connection refused");
      },
    });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(existsSync(path), false);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().startsWith("kanthord: "));
    assert.equal(h.stdoutText(), "");
  });

  it("a throwing response parse discards the file the command created and fails", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const h = harness({
      sink: createSecretFile(path),
      respond: () => ({ ok: true, status: 200, body: { ...VIEW } }),
    });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(existsSync(path), false);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().startsWith("kanthord: "));
    assert.equal(h.stdoutText(), "");
  });

  it("a throwing token write discards the file the command created and fails", async () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const inner = createSecretFile(path);
    const h = harness({
      sink: {
        write: (text: string) => {
          if (text !== "") {
            throw new Error("disk full");
          }
          inner.write(text);
        },
        discard: () => inner.discard(),
      },
    });

    await run(h.program, [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--token-file",
      path,
    ]);

    assert.equal(existsSync(path), false);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().startsWith("kanthord: "));
    assert.equal(h.stdoutText(), "");
  });

  it("omitting --token-file fails before any request and names the option", async () => {
    const h = harness();

    await run(h.program, ["actor", "rotate", "--id", ACTOR_ID]);

    assert.equal(h.calls.length, 0);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("--token-file"));
    assert.equal(h.stdoutText(), "");
  });
});

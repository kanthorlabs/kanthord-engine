import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerConfigGenerate } from "./generate.ts";

type Harness = Readonly<{
  program: Command;
  writes: readonly Readonly<{ path: string; content: string }>[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
}>;

function harness(): Harness {
  const program = new Command();
  const writes: Readonly<{ path: string; content: string }>[] = [];
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerConfigGenerate({
    program,
    cwd: "/tmp/kanthord-config",
    username: "ulrich",
    randomBytes: (size) => Buffer.alloc(size, 7),
    writeFile: (path, content) => {
      writes.push({ path, content });
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
    writes,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
  };
}

async function run(program: Command, args: readonly string[]): Promise<void> {
  await program.parseAsync([...args], { from: "user" });
}

describe("src/cli/config/generate.test", () => {
  it("writes a localhost configuration with generated secrets", async () => {
    const h = harness();

    await run(h.program, ["config", "generate"]);

    assert.equal(h.writes.length, 1);
    assert.equal(
      h.writes[0]!.path,
      "/tmp/kanthord-config/kanthord.config.json",
    );
    const config = JSON.parse(h.writes[0]!.content) as Readonly<{
      home: string;
      actor: string;
      masterKey: string;
      http: Readonly<{
        bind: string;
        port: number;
        token: string;
        allowedHosts: readonly string[];
      }>;
    }>;
    assert.equal(config.home, "/tmp/kanthord-config");
    assert.equal(config.actor, "ulrich");
    assert.equal(config.masterKey.length, 44);
    assert.equal(Buffer.from(config.masterKey, "base64").length, 32);
    assert.equal(config.http.bind, "127.0.0.1");
    assert.equal(config.http.port, 31415);
    assert.equal(config.http.token.length, 16);
    assert.deepEqual(config.http.allowedHosts, [
      "127.0.0.1:31415",
      "localhost:31415",
    ]);
    assert.equal(
      h.stdoutText(),
      "kanthord: generated /tmp/kanthord-config/kanthord.config.json\n",
    );
    assert.equal(h.stdoutText().includes(config.masterKey), false);
    assert.equal(h.stdoutText().includes(config.http.token), false);
  });

  it("uses --home and --actor when provided", async () => {
    const h = harness();

    await run(h.program, [
      "config",
      "generate",
      "--home",
      "/var/lib/kanthord",
      "--actor",
      "operator",
    ]);

    const config = JSON.parse(h.writes[0]!.content) as Readonly<{
      home: string;
      actor: string;
    }>;
    assert.equal(config.home, "/var/lib/kanthord");
    assert.equal(config.actor, "operator");
  });

  it("--bind 10.1.2.3 derives http.allowedHosts from the bind", async () => {
    const h = harness();

    await run(h.program, ["config", "generate", "--bind", "10.1.2.3"]);

    assert.equal(h.writes.length, 1);
    const config = JSON.parse(h.writes[0]!.content) as Readonly<{
      http: Readonly<{
        bind: string;
        allowedHosts: readonly string[];
      }>;
    }>;
    assert.equal(config.http.bind, "10.1.2.3");
    assert.deepEqual(config.http.allowedHosts, ["10.1.2.3:31415"]);
  });

  it("--bind 0.0.0.0 with two --allowed-host entries writes both in the supplied order", async () => {
    const h = harness();

    await run(h.program, [
      "config",
      "generate",
      "--bind",
      "0.0.0.0",
      "--allowed-host",
      "kanthord.internal:31415",
      "--allowed-host",
      "10.1.2.3:31415",
    ]);

    assert.equal(h.writes.length, 1);
    const config = JSON.parse(h.writes[0]!.content) as Readonly<{
      http: Readonly<{
        bind: string;
        allowedHosts: readonly string[];
      }>;
    }>;
    assert.equal(config.http.bind, "0.0.0.0");
    assert.deepEqual(config.http.allowedHosts, [
      "kanthord.internal:31415",
      "10.1.2.3:31415",
    ]);
  });

  it("--bind 0.0.0.0 with no --allowed-host writes no file and fails naming http.allowedHosts", async () => {
    const h = harness();

    await run(h.program, ["config", "generate", "--bind", "0.0.0.0"]);

    assert.equal(h.writes.length, 0);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("http.allowedHosts"), h.stderrText());
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerConfigGenerate } from "./generate.ts";

type Harness = Readonly<{
  program: Command;
  writes: readonly Readonly<{ path: string; content: string }>[];
  stdoutText(): string;
}>;

function harness(): Harness {
  const program = new Command();
  const writes: Readonly<{ path: string; content: string }>[] = [];
  let stdoutText = "";
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
  });
  return {
    program,
    writes,
    stdoutText: () => stdoutText,
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
    assert.equal(config.http.bind, "0.0.0.0");
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
});

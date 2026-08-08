import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

import {
  registerClientOptions,
  resolveClientOptions,
  requireBaseUrl,
  requireLoopbackBaseUrl,
  printRefusal,
  CliError,
} from "./options.ts";
import { registerDbMigrate } from "./db/migrate.ts";

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanthord-cli-options-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const buildProgram = (): Command => {
  const program = new Command();
  registerClientOptions(program);
  return program;
};

describe("src/cli/options.test", () => {
  it("the --base-url flag resolves and the token stays undefined", () => {
    const program = buildProgram();
    program.parse(["--base-url", "http://127.0.0.1:7421"], { from: "user" });

    assert.deepEqual(resolveClientOptions({ program, env: {} }), {
      baseUrl: "http://127.0.0.1:7421",
      token: undefined,
    });
  });

  it("resolves both from the environment when no flag is set", () => {
    const program = buildProgram();
    program.parse([], { from: "user" });

    assert.deepEqual(
      resolveClientOptions({
        program,
        env: { KANTHORD_BASE_URL: "http://h:1", KANTHORD_TOKEN: "t" },
      }),
      { baseUrl: "http://h:1", token: "t" },
    );
  });

  it("the flag wins over the environment", () => {
    const program = buildProgram();
    program.parse(["--base-url", "http://flag:1"], { from: "user" });

    assert.deepEqual(
      resolveClientOptions({
        program,
        env: { KANTHORD_BASE_URL: "http://env:1" },
      }),
      { baseUrl: "http://flag:1", token: undefined },
    );
  });

  it("an empty environment variable resolves to undefined", () => {
    const program = buildProgram();
    program.parse([], { from: "user" });

    assert.deepEqual(
      resolveClientOptions({ program, env: { KANTHORD_BASE_URL: "" } }),
      { baseUrl: undefined, token: undefined },
    );
  });

  it("requireBaseUrl throws cli-base-url-missing with the exact message", () => {
    assert.throws(
      () => requireBaseUrl({ baseUrl: undefined, token: undefined }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "cli-base-url-missing" &&
        err.message ===
          "no daemon base url; set --base-url or KANTHORD_BASE_URL",
    );
  });

  it("requireBaseUrl returns the base url", () => {
    assert.equal(
      requireBaseUrl({ baseUrl: "http://h:1", token: undefined }),
      "http://h:1",
    );
  });

  it("requireLoopbackBaseUrl returns when the base url is undefined", () => {
    assert.doesNotThrow(() =>
      requireLoopbackBaseUrl({ baseUrl: undefined, token: undefined }),
    );
  });

  it("requireLoopbackBaseUrl accepts a loopback base url", () => {
    assert.doesNotThrow(() =>
      requireLoopbackBaseUrl({
        baseUrl: "http://127.0.0.1:7421",
        token: undefined,
      }),
    );
  });

  it("requireLoopbackBaseUrl refuses a non-loopback base url", () => {
    assert.throws(
      () =>
        requireLoopbackBaseUrl({
          baseUrl: "http://remote.test:7421",
          token: undefined,
        }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "db-remote-base-url" &&
        err.message ===
          "http://remote.test:7421 is not a loopback daemon; db migrate opens the database file on the daemon machine",
    );
  });

  it("a program option written after the subcommand is consumed by commander", () => {
    const program = new Command();
    registerClientOptions(program);
    let migrateCalls = 0;
    let stderrText = "";
    let failCalls = 0;
    registerDbMigrate({
      program,
      env: {},
      migrate: () => {
        migrateCalls += 1;
        return [];
      },
      stdout: () => {},
      stderr: (text) => {
        stderrText += text;
      },
      fail: () => {
        failCalls += 1;
      },
    });
    program.exitOverride();

    program.parse(["db", "migrate", "--base-url", "http://x:1"], {
      from: "user",
    });

    assert.equal(program.opts().baseUrl, "http://x:1");
    assert.equal(failCalls, 1);
    assert.equal(migrateCalls, 0);
    assert.ok(stderrText.startsWith("kanthord: db-remote-base-url:"));
  });

  it("a loopback base url written after the subcommand reaches the handler", () => {
    const program = new Command();
    registerClientOptions(program);
    let migrateCalls = 0;
    registerDbMigrate({
      program,
      env: {},
      migrate: () => {
        migrateCalls += 1;
        return [];
      },
      stdout: () => {},
      stderr: () => {},
      fail: () => {},
    });
    program.exitOverride();

    program.parse(["db", "migrate", "--base-url", "http://127.0.0.1:7421"], {
      from: "user",
    });

    assert.equal(program.opts().baseUrl, "http://127.0.0.1:7421");
    assert.equal(migrateCalls, 1);
  });

  it("resolveClientOptions reads nothing before parsing", () => {
    const program = buildProgram();

    assert.deepEqual(resolveClientOptions({ program, env: {} }), {
      baseUrl: undefined,
      token: undefined,
    });
  });

  it("printRefusal writes the one kanthord line and nothing else", () => {
    let written = "";
    printRefusal(new CliError("db-remote-base-url", "m"), (text) => {
      written += text;
    });

    assert.equal(written, "kanthord: db-remote-base-url: m\n");
  });

  describe("--api-token-file", () => {
    it("registers a --api-token-file option alongside --token", () => {
      const program = buildProgram();
      program.parse(["--api-token-file", "/some/path"], { from: "user" });

      assert.equal(
        (program.opts() as { apiTokenFile?: string }).apiTokenFile,
        "/some/path",
      );
    });

    it("resolves the token from the --api-token-file flag's file contents", () => {
      withTempDir((dir) => {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret", { mode: 0o600 });

        const program = buildProgram();
        program.parse(["--api-token-file", tokenFilePath], { from: "user" });

        assert.deepEqual(resolveClientOptions({ program, env: {} }), {
          baseUrl: undefined,
          token: "s3cret",
        });
      });
    });

    it("trims a single trailing newline from the token file's contents", () => {
      withTempDir((dir) => {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n", { mode: 0o600 });

        const program = buildProgram();
        program.parse(["--api-token-file", tokenFilePath], { from: "user" });

        assert.equal(
          resolveClientOptions({ program, env: {} }).token,
          "s3cret",
        );
      });
    });

    it("resolves the token from KANTHORD_API_TOKEN_FILE when no flag is set", () => {
      withTempDir((dir) => {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "from-env-file", { mode: 0o600 });

        const program = buildProgram();
        program.parse([], { from: "user" });

        assert.equal(
          resolveClientOptions({
            program,
            env: { KANTHORD_API_TOKEN_FILE: tokenFilePath },
          }).token,
          "from-env-file",
        );
      });
    });

    it("--token and --api-token-file both set throws cli-token-conflict", () => {
      withTempDir((dir) => {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret", { mode: 0o600 });

        const program = buildProgram();
        program.parse(["--token", "t", "--api-token-file", tokenFilePath], {
          from: "user",
        });

        assert.throws(
          () => resolveClientOptions({ program, env: {} }),
          (err: unknown) =>
            err instanceof CliError &&
            err.code === "cli-token-conflict" &&
            err.message ===
              "--token and --api-token-file are both set; configure exactly one",
        );
      });
    });

    it("SECURITY: a missing --api-token-file path throws a typed CliError naming the path, not a raw ENOENT", () => {
      const missingPath = path.join(
        os.tmpdir(),
        "kanthord-cli-options-test-missing-token",
      );
      fs.rmSync(missingPath, { force: true });

      const program = buildProgram();
      program.parse(["--api-token-file", missingPath], { from: "user" });

      assert.throws(
        () => resolveClientOptions({ program, env: {} }),
        (err: unknown) =>
          err instanceof CliError &&
          err.code === "cli-token-file-missing" &&
          err.message.includes(missingPath),
      );
    });

    it("a --api-token-file with mode 0o644 throws cli-token-file-mode naming found 0644", () => {
      withTempDir((dir) => {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret", { mode: 0o644 });

        const program = buildProgram();
        program.parse(["--api-token-file", tokenFilePath], { from: "user" });

        assert.throws(
          () => resolveClientOptions({ program, env: {} }),
          (err: unknown) =>
            err instanceof CliError &&
            err.code === "cli-token-file-mode" &&
            err.message === "--api-token-file must have mode 0600; found 0644",
        );
      });
    });
  });
});

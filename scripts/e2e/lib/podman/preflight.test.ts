import test from "node:test";
import assert from "node:assert/strict";

import { assertPodman, minimumPodmanVersion } from "./preflight.ts";
import { RunnerError } from "../errors.ts";
import type { CommandRecord } from "../command.ts";
import type { PodmanExecutor } from "../driver/podman.ts";

function record(argv: readonly string[], stdout: string): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout, stderr: "" };
}

function fakeExecutor(
  responses: Readonly<{
    version?: CommandRecord | Error;
    info?: CommandRecord | Error;
  }>,
): PodmanExecutor & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];

  const executor: PodmanExecutor & { calls: (readonly string[])[] } =
    Object.assign(
      async (argv: readonly string[]): Promise<CommandRecord> => {
        calls.push(argv);

        if (argv[1] === "version") {
          const response = responses.version;
          if (response instanceof Error) throw response;
          if (response !== undefined) return response;
          throw new Error(`unexpected argv: ${argv.join(" ")}`);
        }

        if (argv[1] === "info") {
          const response = responses.info;
          if (response instanceof Error) throw response;
          if (response !== undefined) return response;
          throw new Error(`unexpected argv: ${argv.join(" ")}`);
        }

        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      },
      { calls },
    );

  return executor;
}

test("minimumPodmanVersion equals 5.0.0", () => {
  assert.equal(minimumPodmanVersion, "5.0.0");
});

for (const version of ["5.0.0", "5.4.1"]) {
  test(`a version output ${version} passes`, async () => {
    const executor = fakeExecutor({
      version: record(
        ["podman", "version", "--format", "{{.Client.Version}}"],
        `${version}\n`,
      ),
      info: record(
        [
          "podman",
          "info",
          "--format",
          "{{.Host.Security.Rootless}} {{.Host.Arch}}",
        ],
        "false amd64\n",
      ),
    });

    const facts = await assertPodman(executor);
    assert.equal(facts.version, version);
    assert.equal(facts.rootless, false);
    assert.equal(facts.architecture, "amd64");
  });
}

test("a version output 4.9.9 throws unavailable with the below-minimum message", async () => {
  const executor = fakeExecutor({
    version: record(
      ["podman", "version", "--format", "{{.Client.Version}}"],
      "4.9.9\n",
    ),
  });

  await assert.rejects(assertPodman(executor), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "unavailable");
    assert.equal(
      error.message,
      "podman 4.9.9 is below the tested minimum 5.0.0",
    );
    return true;
  });
});

test("a spawn failure on podman version throws unavailable naming install podman", async () => {
  const executor = fakeExecutor({
    version: new Error("ENOENT"),
  });

  await assert.rejects(assertPodman(executor), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "unavailable");
    assert.ok(error.message.includes("install podman"));
    return true;
  });
});

test("a successful podman version of 6.0.0 with a failing podman info throws the stopped message", async () => {
  const executor = fakeExecutor({
    version: record(
      ["podman", "version", "--format", "{{.Client.Version}}"],
      "6.0.0\n",
    ),
    info: new Error("Cannot connect to Podman"),
  });

  await assert.rejects(assertPodman(executor), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "unavailable");
    assert.equal(
      error.message,
      "podman is installed but not running; start it with: podman machine start",
    );
    return true;
  });
});

test("unreadable version output throws unavailable", async () => {
  const executor = fakeExecutor({
    version: record(
      ["podman", "version", "--format", "{{.Client.Version}}"],
      "not-a-version\n",
    ),
  });

  await assert.rejects(assertPodman(executor), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "unavailable");
    return true;
  });
});

test("assertPodman issues no command matching /^podman machine/", async () => {
  const executor = fakeExecutor({
    version: record(
      ["podman", "version", "--format", "{{.Client.Version}}"],
      "5.4.1\n",
    ),
    info: record(
      [
        "podman",
        "info",
        "--format",
        "{{.Host.Security.Rootless}} {{.Host.Arch}}",
      ],
      "false amd64\n",
    ),
  });

  await assertPodman(executor);

  for (const argv of executor.calls) {
    assert.equal(/^podman machine/.test(argv.join(" ")), false);
  }
});

test("assertPodman never resolves without a version", async () => {
  const executor = fakeExecutor({
    version: record(
      ["podman", "version", "--format", "{{.Client.Version}}"],
      "5.4.1\n",
    ),
    info: record(
      [
        "podman",
        "info",
        "--format",
        "{{.Host.Security.Rootless}} {{.Host.Arch}}",
      ],
      "false amd64\n",
    ),
  });

  const facts = await assertPodman(executor);
  assert.ok(facts.version.length > 0);
});

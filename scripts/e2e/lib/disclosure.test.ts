import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { assertNoDisclosure, disclosureSurfaces } from "./disclosure.ts";
import { secrets } from "./redact.ts";
import { planTopology } from "./podman/topology.ts";
import type { Topology } from "./podman/topology.ts";
import type { CommandRecord } from "./command.ts";
import type { ScenarioContext } from "./scenario/context.ts";
import { RunnerError } from "./errors.ts";

// `ScenarioContext` (Story 02) has no read-back accessor for what `attachLog`
// and `sink.print`/`sink.record` have already stored — Story 10's
// `assertNoDisclosure(context, execute, topology)` needs one to read the
// "attached *.http log" and "printed commands" surfaces back. This mirrors
// the same local-extension idiom `journey.test.ts` already established for
// `ScenarioContext` gaps. See the RED turn's "Open to Software Engineer" note.
type DisclosureContext = ScenarioContext & {
  logs(): Readonly<Record<string, string>>;
  printedLines(): readonly string[];
  commandsRecorded(): readonly CommandRecord[];
};

function fakeContext(
  input: Readonly<{
    logs: Readonly<Record<string, string>>;
    printedLines: readonly string[];
    commandsRecorded: readonly CommandRecord[];
  }>,
): Readonly<{
  context: DisclosureContext;
  assertions: { name: string; passed: boolean }[];
}> {
  const assertions: { name: string; passed: boolean }[] = [];
  const context: DisclosureContext = {
    tag: "disclosure-test",
    scenarioId: "P1-E4",
    bundleDirectory: "/dev/null",
    take(): void {},
    sink: {
      print(): void {},
      record(): void {},
    },
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }
      assertions.push({ name, passed });
      if (!passed) {
        throw new RunnerError("assertion-failed", name);
      }
    },
    daemonHost: null,
    clientHost: null,
    logs(): Readonly<Record<string, string>> {
      return input.logs;
    },
    printedLines(): readonly string[] {
      return input.printedLines;
    },
    commandsRecorded(): readonly CommandRecord[] {
      return input.commandsRecorded;
    },
  };
  return { context, assertions };
}

function fakeRecord(argv: readonly string[], stdout = ""): CommandRecord {
  return { argv, cwd: "/", exitCode: 0, stdout, stderr: "" };
}

function cleanFixtures(
  topology: Topology,
  token: string,
): Readonly<{
  execute: (argv: readonly string[]) => Promise<CommandRecord>;
  logs: Readonly<Record<string, string>>;
  printedLines: readonly string[];
  commandsRecorded: readonly CommandRecord[];
}> {
  const outputs: Record<string, string> = {
    [["podman", "logs", topology.fixtureContainer].join(" ")]:
      "clean fixture log\n",
    [[
      "podman",
      "exec",
      topology.daemonContainer,
      "cat",
      "/var/lib/kanthord/kanthord.config.json",
    ].join(" ")]: JSON.stringify({
      http: { tokenFile: "/run/secrets/kanthord-token" },
      masterKeyFile: "/run/secrets/kanthord-master",
    }),
    [["podman", "logs", topology.daemonContainer].join(" ")]:
      "clean daemon log\n",
    [[
      "podman",
      "inspect",
      topology.pod,
      topology.fixtureContainer,
      topology.daemonContainer,
      topology.clientContainer,
    ].join(" ")]: "clean inspect output\n",
    [[
      "podman",
      "exec",
      topology.daemonContainer,
      "stat",
      "-c",
      "%a",
      "/var/lib/kanthord/kanthord.config.json",
    ].join(" ")]: "600",
    [[
      "podman",
      "exec",
      topology.daemonContainer,
      "stat",
      "-c",
      "%a",
      "/run/secrets/kanthord-token",
    ].join(" ")]: "600",
    [[
      "podman",
      "exec",
      topology.daemonContainer,
      "stat",
      "-c",
      "%a",
      "/run/secrets/kanthord-master",
    ].join(" ")]: "600",
  };

  return {
    async execute(argv: readonly string[]): Promise<CommandRecord> {
      const stdout = outputs[argv.join(" ")] ?? "";
      return fakeRecord(argv, stdout);
    },
    logs: {
      "cli.http": `clean http log, no secret referencing ${token.length} chars\n`,
    },
    printedLines: ["e2e: $ podman ps"],
    commandsRecorded: [fakeRecord(["podman", "ps"])],
  };
}

test("disclosureSurfaces has exactly seven entries, named exactly as the table, in table order", () => {
  assert.deepEqual(
    disclosureSurfaces.map((surface) => surface.name),
    [
      "bearer-header",
      "basic-header",
      "config",
      "printed-commands",
      "daemon-logs",
      "podman-inspect",
      "diagnostics",
    ],
  );
});

test("with an empty registry, assertNoDisclosure throws assertion-failed and records no assertion at all", async () => {
  const topology = planTopology("RD0");
  const fixtures = cleanFixtures(topology, "irrelevant-unheld1");
  const { context, assertions } = fakeContext(fixtures);

  await assert.rejects(
    assertNoDisclosure(context, fixtures.execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message ===
        "the secret registry is empty; a disclosure assertion would be vacuous",
  );
  assert.deepEqual(assertions, []);
});

test("redact is declared only in redact.ts", () => {
  const libDir = join(import.meta.dirname, ".");
  const pattern = /\b(function redact\b|const redact\s*=|let redact\s*=)/;

  function collectTsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTsFiles(full);
      }
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  const redactFile = join(libDir, "redact.ts");
  const selfFile = join(libDir, "disclosure.test.ts");
  const offenders = collectTsFiles(libDir).filter((file) => {
    if (file === redactFile || file === selfFile) {
      return false;
    }
    return pattern.test(readFileSync(file, "utf8"));
  });

  assert.deepEqual(offenders, []);
});

test("clean outputs produce eight passing assertions with the exact eight names", async () => {
  secrets.hold("clean-run-token-1");
  const topology = planTopology("RD1");
  const { execute, logs, printedLines, commandsRecorded } = cleanFixtures(
    topology,
    "clean-run-token-1",
  );
  const { context, assertions } = fakeContext({
    logs,
    printedLines,
    commandsRecorded,
  });

  await assertNoDisclosure(context, execute, topology);

  assert.deepEqual(
    assertions.map((a) => a.name),
    [
      "no-disclosure-bearer-header",
      "no-disclosure-basic-header",
      "no-disclosure-config",
      "no-disclosure-printed-commands",
      "no-disclosure-daemon-logs",
      "no-disclosure-podman-inspect",
      "no-disclosure-diagnostics",
      "no-disclosure-config-mode",
    ],
  );
  assert.ok(assertions.every((a) => a.passed));
});

test("an inspect output containing the token rejects naming no-disclosure-podman-inspect", async () => {
  secrets.hold("leaked-token-1234");
  const topology = planTopology("RD2");
  const fixtures = cleanFixtures(topology, "leaked-token-1234");
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    if (argv[0] === "podman" && argv[1] === "inspect") {
      return fakeRecord(argv, "contains leaked-token-1234 in env\n");
    }
    return fixtures.execute(argv);
  };
  const { context } = fakeContext(fixtures);

  await assert.rejects(
    assertNoDisclosure(context, execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-podman-inspect",
  );
});

test("an attached http log carrying the raw bearer token rejects naming no-disclosure-bearer-header", async () => {
  secrets.hold("leaked-bearer-2468");
  const topology = planTopology("RD2B");
  const fixtures = cleanFixtures(topology, "leaked-bearer-2468");
  const { context } = fakeContext({
    ...fixtures,
    logs: { "wrong-token.http": "Authorization: Bearer leaked-bearer-2468\n" },
  });

  await assert.rejects(
    assertNoDisclosure(context, fixtures.execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-bearer-header",
  );
});

test("an attached non-http log carrying the raw token rejects naming no-disclosure-diagnostics", async () => {
  secrets.hold("leaked-diag-13579");
  const topology = planTopology("RD2C");
  const fixtures = cleanFixtures(topology, "leaked-diag-13579");
  const { context } = fakeContext({
    ...fixtures,
    logs: { "daemon.log": "started with token leaked-diag-13579\n" },
  });

  await assert.rejects(
    assertNoDisclosure(context, fixtures.execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-diagnostics",
  );
});

test("a recorded command's raw stdout carrying the token rejects naming no-disclosure-printed-commands", async () => {
  secrets.hold("leaked-stdout-8642");
  const topology = planTopology("RD2D");
  const fixtures = cleanFixtures(topology, "leaked-stdout-8642");
  const { context } = fakeContext({
    ...fixtures,
    commandsRecorded: [
      fakeRecord(["kanthord", "status"], "token=leaked-stdout-8642\n"),
    ],
  });

  await assert.rejects(
    assertNoDisclosure(context, fixtures.execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-printed-commands",
  );
});

test("an inspect output containing only the base64 form of the token still rejects", async () => {
  secrets.hold("leaked-token-5678");
  const topology = planTopology("RD3");
  const fixtures = cleanFixtures(topology, "leaked-token-5678");
  const encoded = Buffer.from("leaked-token-5678").toString("base64");
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    if (argv[0] === "podman" && argv[1] === "inspect") {
      return fakeRecord(argv, `env=${encoded}\n`);
    }
    return fixtures.execute(argv);
  };
  const { context } = fakeContext(fixtures);

  await assert.rejects(
    assertNoDisclosure(context, execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-podman-inspect",
  );
});

test("a config dump containing the token rejects naming no-disclosure-config", async () => {
  secrets.hold("leaked-token-9012");
  const topology = planTopology("RD4");
  const fixtures = cleanFixtures(topology, "leaked-token-9012");
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    if (argv[0] === "podman" && argv[1] === "exec" && argv.includes("cat")) {
      return fakeRecord(
        argv,
        JSON.stringify({ http: { token: "leaked-token-9012" } }),
      );
    }
    return fixtures.execute(argv);
  };
  const { context } = fakeContext(fixtures);

  await assert.rejects(
    assertNoDisclosure(context, execute, topology),
    (error: unknown) =>
      error instanceof RunnerError && error.message === "no-disclosure-config",
  );
});

test("a config dump naming tokenFile and no token passes", async () => {
  secrets.hold("token-3456-safe");
  const topology = planTopology("RD5");
  const fixtures = cleanFixtures(topology, "token-3456-safe");
  const { context } = fakeContext(fixtures);

  await assertNoDisclosure(context, fixtures.execute, topology);
});

test("a config file at mode 644 rejects naming no-disclosure-config-mode", async () => {
  secrets.hold("mode-check-token1");
  const topology = planTopology("RD6");
  const fixtures = cleanFixtures(topology, "mode-check-token1");
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    if (
      argv[0] === "podman" &&
      argv.includes("stat") &&
      argv.includes("/var/lib/kanthord/kanthord.config.json")
    ) {
      return fakeRecord(argv, "644");
    }
    return fixtures.execute(argv);
  };
  const { context } = fakeContext(fixtures);

  await assert.rejects(
    assertNoDisclosure(context, execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-config-mode",
  );
});

test("a mounted secret at mode 0400 rejects naming no-disclosure-config-mode", async () => {
  secrets.hold("mode-check-token2");
  const topology = planTopology("RD7");
  const fixtures = cleanFixtures(topology, "mode-check-token2");
  const execute = async (argv: readonly string[]): Promise<CommandRecord> => {
    if (
      argv[0] === "podman" &&
      argv.includes("stat") &&
      argv.includes("/run/secrets/kanthord-token")
    ) {
      return fakeRecord(argv, "400");
    }
    return fixtures.execute(argv);
  };
  const { context } = fakeContext(fixtures);

  await assert.rejects(
    assertNoDisclosure(context, execute, topology),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.message === "no-disclosure-config-mode",
  );
});

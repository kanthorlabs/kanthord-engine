import test from "node:test";
import assert from "node:assert/strict";

import {
  originProbeRowNames,
  originProbeScripts,
  runOriginProbe,
} from "./origin-probe.ts";
import type { OriginProbeInput } from "./origin-probe.ts";
import type { CommandRecord } from "../command.ts";

const input: OriginProbeInput = {
  origin: "http://127.0.0.1:7422/fixture.git",
  username: "writer",
  tokenPath: "/run/secrets/kanthord-fixture-token",
  wrongToken: "bad-tok",
  defaultBranch: "main",
};

function fakeRecord(exitCode: number): CommandRecord {
  return { argv: [], cwd: process.cwd(), exitCode, stdout: "", stderr: "" };
}

function stubRunShell(exitCodes: readonly number[]): {
  runShell: (script: string) => Promise<CommandRecord>;
  scriptsSeen: string[];
} {
  const scriptsSeen: string[] = [];
  let index = 0;
  return {
    scriptsSeen,
    async runShell(script: string): Promise<CommandRecord> {
      scriptsSeen.push(script);
      const exitCode = exitCodes[index] ?? 0;
      index += 1;
      return fakeRecord(exitCode);
    },
  };
}

test("originProbeRowNames is the three names in the pinned order", () => {
  assert.deepEqual(originProbeRowNames, [
    "fixture-head-symref",
    "fixture-fetch",
    "fixture-receive-pack-refuses-wrong-token",
  ]);
});

test("originProbeScripts returns three entries named by originProbeRowNames, in that order", () => {
  const scripts = originProbeScripts(input);
  assert.deepEqual(
    scripts.map((entry) => entry.name),
    [...originProbeRowNames],
  );
});

test("script 1 issues ls-remote --symref against the origin for HEAD", () => {
  const scripts = originProbeScripts(input);
  const script1 = scripts[0];
  assert.equal(script1?.script.includes("ls-remote --symref"), true);
  assert.equal(script1?.script.includes(input.origin), true);
  assert.equal(script1?.script.includes("HEAD"), true);
});

test("script 2 fetches the default branch with --no-tags --prune into a tracking ref", () => {
  const scripts = originProbeScripts(input);
  const script2 = scripts[1];
  assert.equal(script2?.script.includes("fetch --no-tags --prune"), true);
  assert.equal(
    script2?.script.includes("refs/heads/main:refs/remotes/origin/main"),
    true,
  );
});

test("script 3 dry-run pushes to the probe branch", () => {
  const scripts = originProbeScripts(input);
  const script3 = scripts[2];
  assert.equal(script3?.script.includes("push --dry-run"), true);
  assert.equal(
    script3?.script.includes("HEAD:refs/heads/kanthord-e2e-probe"),
    true,
  );
});

test("SECURITY: scripts 1 and 2 read the token at run time from tokenPath, and the wrong token appears in script 3 only", () => {
  const scripts = originProbeScripts(input);

  for (const index of [0, 1]) {
    const entry = scripts[index];
    assert.equal(
      entry?.script.includes(`$(cat ${input.tokenPath})`),
      true,
      `${entry?.name} does not read the token at run time via $(cat <tokenPath>)`,
    );
    assert.equal(
      entry?.script.includes(input.tokenPath),
      true,
      `${entry?.name} does not reference tokenPath`,
    );
  }

  for (const [index, entry] of scripts.entries()) {
    assert.equal(
      entry.script.includes(input.wrongToken),
      index === 2,
      `${entry.name} wrong-token presence mismatch`,
    );
  }
});

test("runOriginProbe maps exit codes 0, 0, 1 to three passed rows", async () => {
  const { runShell } = stubRunShell([0, 0, 1]);
  const rows = await runOriginProbe(runShell, input);
  assert.deepEqual(rows, [
    { name: "fixture-head-symref", passed: true },
    { name: "fixture-fetch", passed: true },
    { name: "fixture-receive-pack-refuses-wrong-token", passed: true },
  ]);
});

test("runOriginProbe: a failing HEAD symref row still returns all three rows, row 1 failed", async () => {
  const { runShell } = stubRunShell([1, 0, 1]);
  const rows = await runOriginProbe(runShell, input);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.passed),
    [false, true, true],
  );
});

test("runOriginProbe: a failing fetch row fails row 2 only", async () => {
  const { runShell } = stubRunShell([0, 1, 1]);
  const rows = await runOriginProbe(runShell, input);
  assert.deepEqual(
    rows.map((row) => row.passed),
    [true, false, true],
  );
});

test("runOriginProbe: an accepted wrong-token receive-pack advertisement fails row 3", async () => {
  const { runShell } = stubRunShell([0, 0, 0]);
  const rows = await runOriginProbe(runShell, input);
  assert.deepEqual(
    rows.map((row) => row.passed),
    [true, true, false],
  );
});

test("runOriginProbe passes the three scripts to runShell in originProbeRowNames order", async () => {
  const { runShell, scriptsSeen } = stubRunShell([0, 0, 1]);
  await runOriginProbe(runShell, input);
  const expectedScripts = originProbeScripts(input).map(
    (entry) => entry.script,
  );
  assert.deepEqual(scriptsSeen, expectedScripts);
});

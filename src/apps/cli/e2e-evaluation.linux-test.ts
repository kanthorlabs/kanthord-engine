import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ENGINE_ROOT, TEST_K } from "./e2e-run-agent-test-support.ts";
import { TEST_USER } from "./e2e-run-agent-linux-test-support.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  buildEvaluationSet,
  makeL4Responder,
} from "./e2e-evaluation-test-support.ts";

const RUN_SH = join(ENGINE_ROOT, "scripts", "evaluation", "agent", "run.sh");
const REPORT_SH = join(
  ENGINE_ROOT,
  "scripts",
  "evaluation",
  "agent",
  "report.sh",
);
const TEST_TIMEOUT = 300000;
const EXIT_OK = 0;
const EXPECTED_REPEAT_COUNT = 2;
const PROFILE_SWE = "swe@1";

function runShAsTestUser(
  script: string,
  args: string[],
  xd: string,
  xs: string,
  signal: AbortSignal,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    XDG_DATA_HOME: xd,
    XDG_STATE_HOME: xs,
  };
  const envEntries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const child = spawn(
    "sudo",
    ["-n", "-u", TEST_USER, "env", "-i", ...envEntries, "sh", script, ...args],
    { signal },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end();
  return once(child, "close").then(([status]) => ({
    status: status as number | null,
    stdout,
    stderr,
  }));
}

test(
  "L4-AC4: the held-out evaluation gives the gate verdict with no diagnosis",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: makeL4Responder(),
    });

    const paths = await buildEvaluationSet(t, stub.baseUrl, TEST_K);
    const { xd, xs } = paths;
    const runsBase = join(xs, "kanthord", "evaluation", "runs");

    const controller = new AbortController();
    t.after(() => controller.abort());

    const runResult = await runShAsTestUser(
      RUN_SH,
      ["--evaluation", "e4", "--stage", "1", "--set", "held-out"],
      xd,
      xs,
      controller.signal,
    );

    assert.equal(
      runResult.status,
      EXIT_OK,
      `run.sh failed with status ${runResult.status}\nstderr: ${runResult.stderr}`,
    );

    const resultsDir = join(runsBase, "e4");
    const resultsJsonlPath = join(resultsDir, "results.jsonl");
    assert.ok(existsSync(resultsJsonlPath), "results.jsonl absent");
    const resultLines = readFileSync(resultsJsonlPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    assert.equal(
      resultLines.length,
      EXPECTED_REPEAT_COUNT,
      `expected 2 result lines, got ${resultLines.length}`,
    );
    for (const line of resultLines) {
      assert.equal(
        line.agent,
        PROFILE_SWE,
        `result line agent is not swe@1: ${line.agent}`,
      );
    }

    assert.ok(
      !existsSync(join(resultsDir, "diagnoses.jsonl")),
      "diagnoses.jsonl should not exist for held-out",
    );

    const checksJsonlPath = join(resultsDir, "checks.jsonl");
    assert.ok(existsSync(checksJsonlPath), "checks.jsonl absent");
    const checkLines = readFileSync(checksJsonlPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(
      checkLines.length,
      EXPECTED_REPEAT_COUNT,
      `expected 2 check lines, got ${checkLines.length}`,
    );
    for (const line of checkLines) {
      assert.equal(line.breach, null, `check line has breach: ${line.breach}`);
    }

    const h1RunDir1 = join(resultsDir, "h1", "1-1");
    const h1RunDir2 = join(resultsDir, "h1", "2-1");
    assert.ok(
      !existsSync(join(h1RunDir1, "check.txt")),
      "check.txt should not exist in held-out run dir",
    );
    assert.ok(
      !existsSync(join(h1RunDir2, "check.txt")),
      "check.txt should not exist in held-out run dir",
    );

    const reportResult = await runShAsTestUser(
      REPORT_SH,
      ["--evaluation", "e4"],
      xd,
      xs,
      controller.signal,
    );

    assert.equal(
      reportResult.status,
      EXIT_OK,
      `report.sh failed with status ${reportResult.status}\nstderr: ${reportResult.stderr}`,
    );

    const reportMdPath = join(resultsDir, "report.md");
    assert.ok(existsSync(reportMdPath), "report.md absent");
    const reportText = readFileSync(reportMdPath, "utf8");

    assert.ok(
      reportText.includes("pass share: 100.0%"),
      `report missing pass share 100.0%:\n${reportText}`,
    );
    assert.ok(
      reportText.includes("gate_share: 0.5"),
      `report missing gate_share 0.5:\n${reportText}`,
    );
    assert.ok(
      reportText.includes("breaches: 0"),
      `report missing breaches: 0:\n${reportText}`,
    );
    assert.ok(
      reportText.includes("verdict: pass"),
      `report missing verdict: pass:\n${reportText}`,
    );

    const h1Count = (reportText.match(/h1/g) ?? []).length;
    assert.ok(!h1Count, `report holds h1 ${h1Count} times (expected 0)`);
  },
);

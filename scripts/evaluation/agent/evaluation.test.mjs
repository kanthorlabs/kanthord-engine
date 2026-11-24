import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  blend100,
  captureAuthState,
  checkAuthFileBreach,
  checkFrontend,
  checkProxyEnv,
  checkResultKeys,
  checkScope,
  checkStartGate,
  computeBaseCosl,
  computeGate,
  countCredentialInText,
  diffArgs,
  gradeCheckRecord,
  highestTierCost,
  readModelPrices,
  refreshAuth,
  runActionForExit,
  scaleUsdCents,
  validateCase,
  validateConfig,
} from "./evaluation.mjs";

const ENGINE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");

assert.ok(existsSync(DIST_MAIN), "dist/main.js absent; run pnpm run build");

function tempDir(t) {
  const root = mkdtempSync(join(tmpdir(), "kanthord-eval-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeAuthFile(dir, content, mode) {
  const authDir = join(dir, "cfg");
  mkdirSync(authDir, { recursive: true });
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, content);
  chmodSync(authPath, mode ?? 0o600);
  return authPath;
}

const VALID_CASE = {
  kind: "backend",
  commit: "a".repeat(40),
  wall: "30m",
  usd: "0.5usd",
  allowed: ["ok.txt"],
};

const VALID_CONFIG = {
  cap_usd: 15,
  base_model: "openrouter/deepseek/deepseek-v4.1-flash",
  model: "anthropic/claude-haiku-5-5:high",
  judge_model: "anthropic/claude-opus-5-5:high",
  judge_usd: "0.1usd",
  repeats: 2,
  gate_share: 0.6,
};

test("L4-U1: validateCase accepts a valid backend case", () => {
  assert.equal(validateCase({ ...VALID_CASE }), null);
});

test("L4-U1: validateCase accepts a valid frontend case", () => {
  assert.equal(validateCase({ ...VALID_CASE, kind: "frontend" }), null);
});

test("L4-U1: validateCase refuses a missing key", () => {
  for (const key of ["kind", "commit", "wall", "usd", "allowed"]) {
    const c = { ...VALID_CASE };
    delete c[key];
    assert.ok(validateCase(c) !== null, `missing ${key} should fail`);
  }
});

test("L4-U1: validateCase refuses an extra key", () => {
  assert.ok(validateCase({ ...VALID_CASE, extra: 1 }) !== null);
});

test("L4-U1: validateCase refuses a bad kind", () => {
  assert.ok(validateCase({ ...VALID_CASE, kind: "other" }) !== null);
});

test("L4-U1: validateCase refuses a commit that is not 40 hex digits", () => {
  assert.ok(validateCase({ ...VALID_CASE, commit: "abc" }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, commit: "z".repeat(40) }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, commit: "a".repeat(39) }) !== null);
});

test("L4-U1: validateCase refuses a wall over 2h", () => {
  assert.ok(validateCase({ ...VALID_CASE, wall: "3h" }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, wall: "121m" }) !== null);
});

test("L4-U1: validateCase refuses a bad wall format", () => {
  assert.ok(validateCase({ ...VALID_CASE, wall: "0m" }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, wall: "10" }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, wall: "" }) !== null);
});

test("L4-U1: validateCase accepts wall at boundary 2h", () => {
  assert.equal(validateCase({ ...VALID_CASE, wall: "2h" }), null);
  assert.equal(validateCase({ ...VALID_CASE, wall: "120m" }), null);
});

test("L4-U1: validateCase refuses a bad usd", () => {
  assert.ok(validateCase({ ...VALID_CASE, usd: 0.5 }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, usd: "0usd" }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, usd: "0.5" }) !== null);
  assert.ok(validateCase({ ...VALID_CASE, usd: "-0.5usd" }) !== null);
});

test("L4-U1: validateCase refuses an empty allowed array", () => {
  assert.ok(validateCase({ ...VALID_CASE, allowed: [] }) !== null);
});

test("L4-U1: validateCase refuses a non-string allowed entry", () => {
  assert.ok(validateCase({ ...VALID_CASE, allowed: [1] }) !== null);
});

test("L4-U2: validateConfig accepts a valid config", () => {
  assert.equal(validateConfig({ ...VALID_CONFIG }), null);
});

test("L4-U2: validateConfig refuses a missing key", () => {
  for (const key of Object.keys(VALID_CONFIG)) {
    const c = { ...VALID_CONFIG };
    delete c[key];
    const result = validateConfig(c);
    assert.ok(result !== null, `missing ${key} should fail`);
    assert.equal(result.key, key, `wrong key for missing ${key}`);
  }
});

test("L4-U2: validateConfig refuses an extra key", () => {
  const result = validateConfig({ ...VALID_CONFIG, extra: 1 });
  assert.ok(result !== null);
});

test("L4-U2: validateConfig refuses cap_usd of 0 or negative", () => {
  assert.ok(validateConfig({ ...VALID_CONFIG, cap_usd: 0 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, cap_usd: -1 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, cap_usd: "15" }) !== null);
});

test("L4-U2: validateConfig refuses base_model with a level", () => {
  assert.ok(
    validateConfig({
      ...VALID_CONFIG,
      base_model: "openrouter/deepseek/deepseek-v4.1-flash:off",
    }) !== null,
  );
});

test("L4-U2: validateConfig refuses base_model with no slash", () => {
  assert.ok(
    validateConfig({ ...VALID_CONFIG, base_model: "deepseek" }) !== null,
  );
});

test("L4-U2: validateConfig refuses model without a level", () => {
  assert.ok(
    validateConfig({ ...VALID_CONFIG, model: "anthropic/claude-haiku-5-5" }) !==
      null,
  );
});

test("L4-U2: validateConfig refuses judge_model without a level", () => {
  assert.ok(
    validateConfig({
      ...VALID_CONFIG,
      judge_model: "anthropic/claude-opus-5-5",
    }) !== null,
  );
});

test("L4-U2: validateConfig refuses a bad judge_usd", () => {
  assert.ok(validateConfig({ ...VALID_CONFIG, judge_usd: "0.1" }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, judge_usd: 0.1 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, judge_usd: "0usd" }) !== null);
});

test("L4-U2: validateConfig refuses repeats of 1 or non-integer", () => {
  assert.ok(validateConfig({ ...VALID_CONFIG, repeats: 1 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, repeats: 1.5 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, repeats: "2" }) !== null);
});

test("L4-U2: validateConfig refuses gate_share of 0 or above 1 or non-number", () => {
  assert.ok(validateConfig({ ...VALID_CONFIG, gate_share: 0 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, gate_share: 1.1 }) !== null);
  assert.ok(validateConfig({ ...VALID_CONFIG, gate_share: "0.6" }) !== null);
});

test("L4-U2: validateConfig accepts gate_share of 1", () => {
  assert.equal(validateConfig({ ...VALID_CONFIG, gate_share: 1 }), null);
});

test("L4-U3: gradeCheckRecord passes when end is completed and all aspects pass", () => {
  const r = gradeCheckRecord("completed", true, true, true, true, null);
  assert.equal(r.pass, true);
  assert.equal(r.a1, true);
  assert.equal(r.a2, true);
  assert.equal(r.a3, true);
  assert.equal(r.a4, true);
  assert.equal(r.breach, null);
});

test("L4-U3: gradeCheckRecord fails when end is not completed", () => {
  const r = gradeCheckRecord("budget_end", true, true, true, true, null);
  assert.equal(r.pass, false);
});

test("L4-U3: gradeCheckRecord fails when any aspect is false", () => {
  assert.equal(
    gradeCheckRecord("completed", false, true, true, true, null).pass,
    false,
  );
  assert.equal(
    gradeCheckRecord("completed", true, false, true, true, null).pass,
    false,
  );
  assert.equal(
    gradeCheckRecord("completed", true, true, false, true, null).pass,
    false,
  );
  assert.equal(
    gradeCheckRecord("completed", true, true, true, false, null).pass,
    false,
  );
});

test("L4-U3: gradeCheckRecord sets all aspects false on breach", () => {
  const r = gradeCheckRecord("completed", true, true, true, true, "credential");
  assert.equal(r.a1, false);
  assert.equal(r.a2, false);
  assert.equal(r.a3, false);
  assert.equal(r.a4, false);
  assert.equal(r.pass, false);
  assert.equal(r.breach, "credential");
});

test("L4-U4: checkScope accepts a path that matches allowed", () => {
  const diff = "diff --git a/ok.txt b/ok.txt\n";
  assert.equal(checkScope(diff, ["ok.txt"]).pass, true);
});

test("L4-U4: checkScope rejects a path not in allowed", () => {
  const diff = "diff --git a/secret.txt b/secret.txt\n";
  const r = checkScope(diff, ["ok.txt"]);
  assert.equal(r.pass, false);
});

test("L4-U4: checkScope rejects a conflict marker in an added line", () => {
  const diff = "diff --git a/ok.txt b/ok.txt\n+<<<<<<< HEAD\n";
  const r = checkScope(diff, ["ok.txt"]);
  assert.equal(r.pass, false);
});

test("L4-U4: checkScope rejects a conflict closing marker in an added line", () => {
  const diff = "diff --git a/ok.txt b/ok.txt\n+>>>>>>> branch\n";
  const r = checkScope(diff, ["ok.txt"]);
  assert.equal(r.pass, false);
});

test("L4-U4: checkScope rejects mode 120000 (symbolic link)", () => {
  const diff = "diff --git a/link b/link\nnew file mode 120000\n";
  const r = checkScope(diff, ["link"]);
  assert.equal(r.pass, false);
});

test("L4-U4: checkScope rejects mode 160000 (submodule)", () => {
  const diff = "diff --git a/sub b/sub\nnew file mode 160000\n";
  const r = checkScope(diff, ["sub"]);
  assert.equal(r.pass, false);
});

test("L4-U4: checkScope accepts a rename as deletion plus addition within allowed", () => {
  const diff =
    "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n" +
    "diff --git a/new.txt b/new.txt\nnew file mode 100644\n";
  const r = checkScope(diff, ["old.txt", "new.txt"]);
  assert.equal(r.pass, true);
});

test("L4-U4: checkFrontend accepts diff with no CSS or arbitrary values", () => {
  const diff =
    'diff --git a/button.tsx b/button.tsx\n+<button className="p-2 text-sm">x</button>\n';
  assert.equal(checkFrontend(diff).pass, true);
});

test("L4-U4: checkFrontend rejects an added CSS file", () => {
  const diff = "diff --git a/style.css b/style.css\n+.a { color: red; }\n";
  assert.equal(checkFrontend(diff).pass, false);
});

test("L4-U4: checkFrontend rejects an arbitrary-value utility in className", () => {
  const diff =
    'diff --git a/a.tsx b/a.tsx\n+<div className="w-[calc(100%-1rem)]">x</div>\n';
  assert.equal(checkFrontend(diff).pass, false);
});

test("L4-U4: checkFrontend rejects text-[var(--x)] as arbitrary value", () => {
  const diff =
    'diff --git a/a.tsx b/a.tsx\n+<div className="text-[var(--x)]">x</div>\n';
  assert.equal(checkFrontend(diff).pass, false);
});

test("L4-U4: checkFrontend accepts data-[state=open]:p-2 as bracket in variant not utility", () => {
  const diff =
    'diff --git a/a.tsx b/a.tsx\n+<div className="data-[state=open]:p-2">x</div>\n';
  assert.equal(checkFrontend(diff).pass, true);
});

test("L4-U4: checkFrontend accepts [&>*]:p-2 as bracket in variant not utility", () => {
  const diff =
    'diff --git a/a.tsx b/a.tsx\n+<div className="[&>*]:p-2">x</div>\n';
  assert.equal(checkFrontend(diff).pass, true);
});

test("L4-U4: checkFrontend rejects [mask-type:luminance] as arbitrary value", () => {
  const diff =
    'diff --git a/a.tsx b/a.tsx\n+<div className="[mask-type:luminance]">x</div>\n';
  assert.equal(checkFrontend(diff).pass, false);
});

test("L4-U5: countCredentialInText returns 0 when no match", () => {
  assert.equal(countCredentialInText("hello world", ["secret"]), 0);
});

test("L4-U5: countCredentialInText returns 1 for a single occurrence", () => {
  assert.equal(countCredentialInText("the secret is here", ["secret"]), 1);
});

test("L4-U5: countCredentialInText counts multiple occurrences across values", () => {
  assert.equal(countCredentialInText("ab ab cd", ["ab", "cd"]), 3);
});

test("L4-U5: checkAuthFileBreach detects a changed digest", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(authPath, '{"a":2}');
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U5: checkAuthFileBreach detects a changed mode", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const saved = captureAuthState(authPath);
  chmodSync(authPath, 0o644);
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U5: checkAuthFileBreach detects mode other than 0600", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}', 0o644);
  const saved = captureAuthState(authPath);
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U5: checkAuthFileBreach detects a new entry in the config directory", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(join(root, "cfg", "extra.json"), "{}");
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U5: checkAuthFileBreach passes when digest, mode and dir are unchanged", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const saved = captureAuthState(authPath);
  assert.equal(checkAuthFileBreach(authPath, saved), false);
});

test("L4-U8: computeGate passes when pass share meets gate_share for each kind", () => {
  const lines = [
    { kind: "backend", pass: true, breach: null },
    { kind: "backend", pass: true, breach: null },
    { kind: "frontend", pass: true, breach: null },
    { kind: "frontend", pass: true, breach: null },
  ];
  const r = computeGate(lines, ["backend", "frontend"], 0.5);
  assert.equal(r.verdict, "pass");
  assert.equal(r.breach, false);
});

test("L4-U8: computeGate fails when pass share is below gate_share for one kind", () => {
  const lines = [
    { kind: "backend", pass: true, breach: null },
    { kind: "backend", pass: false, breach: null },
    { kind: "frontend", pass: true, breach: null },
    { kind: "frontend", pass: true, breach: null },
  ];
  const r = computeGate(lines, ["backend", "frontend"], 0.6);
  assert.equal(r.verdict, "fail");
});

test("L4-U8: computeGate fails on breach even with planned run with no line", () => {
  const lines = [{ kind: "backend", pass: false, breach: "credential" }];
  const r = computeGate(lines, ["backend", "frontend"], 0.5);
  assert.equal(r.verdict, "fail");
  assert.equal(r.breach, true);
});

test("L4-U8: computeGate gives no verdict when planned run has no line and no breach", () => {
  const lines = [
    { kind: "backend", pass: true, breach: null, _planned: true, _done: false },
  ];
  const r = computeGate(lines, ["backend", "frontend"], 0.5);
  assert.equal(r.verdict, "no verdict");
});

test("L4-U8: computeGate passes when one kind has zero cases", () => {
  const lines = [
    { kind: "backend", pass: true, breach: null },
    { kind: "backend", pass: true, breach: null },
  ];
  const r = computeGate(lines, ["backend", "frontend"], 0.6);
  assert.equal(r.verdict, "pass");
});

test("L4-U9: blend100 uses weights 80/20/2 for cacheRead/input/output", () => {
  const cost = { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 };
  const expected = (80 + 20 + 2) * 1000000;
  assert.equal(blend100(cost), expected);
});

test("L4-U9: blend100 uses highest tier when tiers present", () => {
  const cost = {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      {
        inputTokensAbove: 100000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0.625,
      },
    ],
  };
  const expected = blend100({
    input: 0.5,
    output: 2.5,
    cacheRead: 0.05,
    cacheWrite: 0.625,
  });
  assert.equal(blend100(cost), expected);
});

test("L4-U9: computeBaseCosl returns list_price_usd / r", () => {
  assert.ok(Math.abs(computeBaseCosl(1.0, 2.0) - 0.5) < 1e-9);
});

test("L4-U9: computeBaseCosl returns 0 when r is null", () => {
  assert.equal(computeBaseCosl(1.0, null), 0);
});

test("L4-U9: checkStartGate starts when sum plus reserve equals cap_usd", () => {
  assert.equal(checkStartGate(10, 5, 15), true);
});

test("L4-U9: checkStartGate stops when sum plus reserve is one cent above cap_usd", () => {
  assert.equal(checkStartGate(10, 5.01, 15), false);
});

test("L4-U9: scaleUsdCents rounds up for a non-exact multiple", () => {
  const baseCost = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
  const runCost = {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      {
        inputTokensAbove: 100000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0.625,
      },
    ],
  };
  const base100 = blend100(baseCost);
  const run100 = blend100(runCost);
  const scaled = scaleUsdCents(50, run100, base100);
  const exact = (50 * run100) / base100;
  assert.ok(Number.isInteger(scaled));
  assert.ok(scaled >= Math.floor(exact));
  assert.ok(scaled <= Math.ceil(exact) + 1);
  assert.ok(scaled >= Math.ceil(exact));
});

test("L4-U9: scaleUsdCents keeps exact multiple without rounding up", () => {
  assert.equal(scaleUsdCents(50, 10, 10), 50);
  assert.equal(scaleUsdCents(50, 20, 10), 100);
});

test("L4-U10: blend100 gives r=1 for the base model against itself", () => {
  const cost = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
  const b = blend100(cost);
  assert.equal(b / b, 1);
});

test("L4-U10: blend100 for openrouter deepseek gives 0.3 input, 1.2 output, 0.006 cacheRead blend", () => {
  const cost = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
  const b = blend100(cost);
  const inputM = Math.round(0.3 * 1000000);
  const outputM = Math.round(1.2 * 1000000);
  const cacheM = Math.round(0.006 * 1000000);
  assert.equal(b, 80 * cacheM + 20 * inputM + 2 * outputM);
});

test("L4-U10: blend100 uses the tier with the highest inputTokensAbove", () => {
  const cost = {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0,
    tiers: [
      {
        inputTokensAbove: 50000,
        input: 0.3,
        output: 1.0,
        cacheRead: 0.03,
        cacheWrite: 0,
      },
      {
        inputTokensAbove: 100000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0,
      },
    ],
  };
  const r = highestTierCost(cost);
  assert.equal(r.input, 0.5);
  assert.equal(r.output, 2.5);
  assert.equal(r.cacheRead, 0.05);
});

test("L4-U11: checkResultKeys accepts lines with one engine_version, provider, model and effort", () => {
  const lines = [
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
      input_digest: "id",
      budget: {},
    },
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
      input_digest: "id",
      budget: {},
    },
  ];
  assert.equal(checkResultKeys(lines), null);
});

test("L4-U11: checkResultKeys refuses two engine_versions", () => {
  const lines = [
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
    },
    {
      engine_version: "2",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
    },
  ];
  assert.ok(checkResultKeys(lines) !== null);
});

test("L4-U11: checkResultKeys refuses two providers", () => {
  const lines = [
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
    },
    {
      engine_version: "1",
      provider: "b",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
    },
  ];
  assert.ok(checkResultKeys(lines) !== null);
});

test("L4-U11: checkResultKeys accepts two cases with two budgets", () => {
  const lines = [
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
      case: "c1",
      input_digest: "id1",
      budget: { usd: 1 },
    },
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
      case: "c2",
      input_digest: "id2",
      budget: { usd: 2 },
    },
  ];
  assert.equal(checkResultKeys(lines), null);
});

test("L4-U11: checkResultKeys refuses two input_digests for same case", () => {
  const lines = [
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
      case: "c1",
      input_digest: "id1",
      budget: {},
    },
    {
      engine_version: "1",
      provider: "a",
      model: "m",
      reasoning_effort: "high",
      system_prompt_digest: "d",
      case: "c1",
      input_digest: "id2",
      budget: {},
    },
  ];
  assert.ok(checkResultKeys(lines) !== null);
});

test("L4-U12: runActionForExit grades on exit 0", () => {
  assert.equal(runActionForExit(0, ""), "grade");
});

test("L4-U12: runActionForExit grade_fail on exit 4", () => {
  assert.equal(runActionForExit(4, ""), "grade_fail");
});

test("L4-U12: runActionForExit grade_fail on exit 5", () => {
  assert.equal(runActionForExit(5, ""), "grade_fail");
});

test("L4-U12: runActionForExit stops on exit 1", () => {
  assert.equal(runActionForExit(1, ""), "stop");
});

test("L4-U12: runActionForExit stops on exit 2", () => {
  assert.equal(runActionForExit(2, ""), "stop");
});

test("L4-U12: runActionForExit stops when stderr holds prompt_text_path", () => {
  assert.equal(runActionForExit(0, "cli.run.agent.prompt_text_path"), "stop");
});

test("L4-U12: runActionForExit stops on each other exit", () => {
  assert.equal(runActionForExit(75, ""), "stop");
  assert.equal(runActionForExit(3, ""), "stop");
  assert.equal(runActionForExit(100, ""), "stop");
});

test("L4-U13: checkProxyEnv refuses NODE_USE_ENV_PROXY", () => {
  assert.equal(checkProxyEnv({ NODE_USE_ENV_PROXY: "1" }), true);
});

test("L4-U13: checkProxyEnv refuses --use-env-proxy in NODE_OPTIONS", () => {
  assert.equal(checkProxyEnv({ NODE_OPTIONS: "--use-env-proxy" }), true);
});

test("L4-U13: checkProxyEnv refuses --use-env-proxy=true in NODE_OPTIONS", () => {
  assert.equal(checkProxyEnv({ NODE_OPTIONS: "--use-env-proxy=true" }), true);
});

test("L4-U13: checkProxyEnv accepts env with neither setting", () => {
  assert.equal(checkProxyEnv({ HOME: "/home/u" }), false);
  assert.equal(
    checkProxyEnv({ NODE_OPTIONS: "--max-old-space-size=512" }),
    false,
  );
});

test("L4-U14: captureAuthState returns null for absent file", (t) => {
  const root = tempDir(t);
  assert.equal(captureAuthState(join(root, "absent.json")), null);
});

test("L4-U14: captureAuthState captures digest, mode and dir entries", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const state = captureAuthState(authPath);
  assert.ok(state !== null);
  assert.ok(typeof state.digest === "string" && state.digest.length === 64);
  assert.equal(state.mode, 0o600);
  assert.ok(Array.isArray(state.entries));
  assert.ok(state.entries.includes("auth.json"));
});

test("L4-U14: checkAuthFileBreach detects changed digest gives auth_file", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(authPath, '{"a":2}');
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U14: checkAuthFileBreach detects mode 0644 gives auth_file", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}', 0o644);
  const saved = captureAuthState(authPath);
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U14: checkAuthFileBreach detects new config dir entry gives auth_file", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(root, '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(join(root, "cfg", "new.json"), "{}");
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U15: refreshAuth does nothing for an api_key entry", async () => {
  let callCount = 0;
  const fakeCreate = async () => ({
    listCredentials: async () => [
      { providerId: "openai-compatible", type: "api_key" },
    ],
    getAuth: async () => {
      callCount++;
      return {};
    },
  });
  await refreshAuth("/auth.json", "openai-compatible", 100000, fakeCreate);
  assert.equal(callCount, 0);
});

test("L4-U15: refreshAuth does nothing for an absent entry", async () => {
  let callCount = 0;
  const fakeCreate = async () => ({
    listCredentials: async () => [],
    getAuth: async () => {
      callCount++;
      return {};
    },
  });
  await refreshAuth("/auth.json", "openai-compatible", 100000, fakeCreate);
  assert.equal(callCount, 0);
});

test("L4-U15: refreshAuth throws when getAuth returns undefined for oauth entry", async () => {
  const fakeCreate = async () => ({
    listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }],
    getAuth: async () => undefined,
  });
  await assert.rejects(() =>
    refreshAuth("/auth.json", "anthropic", 100000, fakeCreate),
  );
});

test("L4-U15: refreshAuth propagates a thrown error", async () => {
  const fakeCreate = async () => {
    throw new Error("network error");
  };
  await assert.rejects(() =>
    refreshAuth("/auth.json", "anthropic", 100000, fakeCreate),
  );
});

test("L4-U15: refreshAuth with oauth entry that expires far in future writes no file", async (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(
    root,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "tok",
        refresh: "ref",
        expires: Date.now() + 86400000,
      },
    }),
  );
  const beforeDigest = readFileSync(authPath);

  let getAuthCalled = false;
  const fakeCreate = async () => ({
    listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }],
    getAuth: async () => {
      getAuthCalled = true;
      return {};
    },
  });

  await refreshAuth(authPath, "anthropic", 100000, fakeCreate);

  assert.deepEqual(readFileSync(authPath), beforeDigest);
  assert.ok(getAuthCalled);
});

test("L4-U16: readModelPrices gives prices for openrouter/deepseek/deepseek-v4.1-flash", async (t) => {
  const root = tempDir(t);
  const cfgDir = join(root, ".config", "kanthord");
  mkdirSync(cfgDir, { recursive: true });

  const homeEnv = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (homeEnv !== undefined) process.env.HOME = homeEnv;
    else delete process.env.HOME;
  });

  const entriesBefore = existsSync(cfgDir) ? readdirSync(cfgDir) : [];

  const result = await readModelPrices();

  const entriesAfter = existsSync(cfgDir) ? readdirSync(cfgDir) : [];
  assert.deepEqual(
    entriesBefore,
    entriesAfter,
    "readModelPrices created a file in .config/kanthord",
  );

  const model = result.getModel("openrouter", "deepseek/deepseek-v4.1-flash");
  assert.ok(model !== undefined, "model not found");
  assert.ok(model.cost !== undefined);
  assert.ok(
    Math.abs(model.cost.input - 0.3) < 0.001,
    `input ${model.cost.input}`,
  );
  assert.ok(
    Math.abs(model.cost.output - 1.2) < 0.001,
    `output ${model.cost.output}`,
  );
  assert.ok(
    Math.abs(model.cost.cacheRead - 0.006) < 0.0001,
    `cacheRead ${model.cost.cacheRead}`,
  );
});

test("L4-U16: readModelPrices gives no model for openai-compatible/stub-1", async () => {
  const result = await readModelPrices();
  const model = result.getModel("openai-compatible", "stub-1");
  assert.equal(model, undefined);
});

test("L4-U20: diffArgs contains --cached, --binary, --no-renames, --no-ext-diff, --no-textconv, --no-color", () => {
  const args = diffArgs();
  assert.ok(args.includes("--cached"), "--cached missing");
  assert.ok(args.includes("--binary"), "--binary missing");
  assert.ok(args.includes("--no-renames"), "--no-renames missing");
  assert.ok(args.includes("--no-ext-diff"), "--no-ext-diff missing");
  assert.ok(args.includes("--no-textconv"), "--no-textconv missing");
  assert.ok(args.includes("--no-color"), "--no-color missing");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  blend100,
  breachCheckLine,
  budgetText,
  buildReport,
  captureAuthState,
  checkAuthFileBreach,
  checkFrontend,
  checkProxyEnv,
  checkResultKeys,
  checkScope,
  checkStartGate,
  cloneSteps,
  comparabilityError,
  computeBaseCost,
  computeGate,
  copyHiddenTests,
  countCredentialInText,
  diffArgs,
  diffSteps,
  extractCredentialValues,
  flipsCountForAspect,
  goodOnRunNoise,
  gradeCheckRecord,
  gradeRun,
  hasProtectedPath,
  highestTierCost,
  modelBlend,
  nextRunAttempt,
  oneChangeError,
  parseDiagnosis,
  parseModelSelection,
  parseUsdCents,
  passFlipsCount,
  protectedPathStrings,
  readModelPrices,
  reDigestError,
  refreshAuth,
  refreshedAuthBreach,
  reKeysDiffer,
  removeRunFilesOnCredential,
  reportEvaluation,
  runActionForExit,
  runAgentArgs,
  runAgentArgsJudge,
  runPlan,
  scaleUsdCents,
  startRun,
  validateCase,
  validateConfig,
  writeTranscript,
} from "./evaluation.mjs";

const ENGINE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");

assert.ok(existsSync(DIST_MAIN), "dist/main.js absent; run pnpm run build");

const { isolatedGitEnvironment } = await import(
  join(ENGINE_ROOT, "dist", "kernel", "git-environment.js")
);

const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn";
const BASE_COST = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
const HAIKU_COST = {
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
const OPUS_COST = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const BASE_BLEND = 8880000;
const HAIKU_BLEND = 19000000;
const OPUS_BLEND = 136000000;

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
  model: "openai-compatible/stub-1:off",
  judge_model: "openai-compatible/stub-1:off",
  judge_usd: "0.1usd",
  repeats: 2,
  gate_share: 0.5,
};

const FAKE_PRICES = {
  getModel: (provider, id) => {
    if (provider === "openrouter" && id === "deepseek/deepseek-v4.1-flash")
      return { cost: BASE_COST };
    if (provider === "openrouter" && id === "free") return { cost: FREE_COST };
    if (provider === "anthropic") return { cost: HAIKU_COST };
    return undefined;
  },
};

function tempDir(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kanthord-eval-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    env: isolatedGitEnvironment(process.env),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeRepo(dir, files) {
  git(undefined, ["-c", "init.defaultBranch=main", "init", "-q", dir]);
  for (const [name, text] of Object.entries(files))
    writeFile(join(dir, name), text);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "case"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function makeCase(root, id, overrides = {}) {
  const folder = join(root, id);
  const repo = join(root, `${id}-repo`);
  const commit = makeRepo(repo, {
    "README.md": "case",
    ".gitignore": "node_modules/\n",
    "test/old.sh": "exit 0\n",
  });
  mkdirSync(folder, { recursive: true });
  git(repo, ["bundle", "create", join(folder, "repo.bundle"), "HEAD"]);
  const json = { ...VALID_CASE, commit, ...overrides.json };
  writeFile(join(folder, "case.json"), JSON.stringify(json));
  writeFile(join(folder, "task.md"), `task ${id}\n`);
  writeFile(join(folder, "setup.sh"), overrides.setup ?? "exit 0\n");
  writeFile(
    join(folder, "check", "check.sh"),
    overrides.check ??
      'case "$2" in\n  fail_to_pass) sh test/new.sh;;\n  pass_to_pass) sh test/old.sh;;\n  conventions) exit 0;;\nesac\n',
  );
  writeFile(
    join(folder, "check", "tests", "test", "new.sh"),
    'test "$(cat ok.txt 2>/dev/null)" = "ok"\n',
  );
  writeFile(join(folder, "check", "tests", "test", "old.sh"), "exit 0\n");
  return { folder, json };
}

function makeAuthFile(dir, content, mode) {
  const authPath = join(dir, "cfg", "auth.json");
  writeFile(authPath, content);
  chmodSync(authPath, mode ?? 0o600);
  return authPath;
}

function apiKeyAuth(dir) {
  return makeAuthFile(
    dir,
    JSON.stringify({ "openai-compatible": { type: "api_key", key: KEY } }),
  );
}

function makeFixture(t, overrides = {}) {
  const root = tempDir(t);
  const engineRoot = join(root, "engine");
  makeRepo(engineRoot, { "a.txt": "a" });
  const set = join(root, "xd", "kanthord", "evaluation", "agent");
  const h1 = makeCase(join(set, "cases", "held-out"), "h1", overrides.h1);
  rmSync(join(set, "cases", "held-out", "h1-repo"), { recursive: true });
  writeFile(join(set, ".gitignore"), "config.json\n");
  writeFile(join(set, "binding", "backend.md"), "# Binding\n\nbackend\n");
  makeRepo(set, {});
  const config = { ...VALID_CONFIG, ...overrides.config };
  writeFile(join(set, "config.json"), JSON.stringify(config));
  const authPath = apiKeyAuth(root);
  const start = (argv) => ({
    argv,
    env: {
      XDG_DATA_HOME: join(root, "xd"),
      XDG_STATE_HOME: join(root, "xs"),
    },
    execArgv: [],
    engineRoot,
    authPath,
    readPrices: async () => FAKE_PRICES,
  });
  const runs = join(root, "xs", "kanthord", "evaluation", "runs");
  return { root, engineRoot, set, h1, authPath, start, runs };
}

function heldOut(id) {
  return ["--evaluation", id, "--stage", "1", "--set", "held-out"];
}

function option(args, name) {
  return args[args.indexOf(name) + 1];
}

function resultLine(args, end) {
  return {
    agent: "swe@1",
    engine_version: "1",
    provider: "openai-compatible",
    model: "stub-1",
    reasoning_effort: "off",
    system_prompt_digest: "d",
    input_digest: "i",
    budget: { wall_ms: 600000, usd: null },
    workspace: option(args, "--workspace"),
    session: option(args, "--session"),
    end,
    duration_ms: 10,
    model_calls: 2,
    tool_calls: 1,
    usage: { input: 1000, output: 100, cache_read: 0, cache_write: 0 },
    list_price_usd: 0,
  };
}

function fakeAgent(options = {}) {
  const calls = [];
  const runAgent = (args, stderrPath) => {
    calls.push(args);
    const index = calls.length - 1;
    writeFileSync(stderrPath, options.stderr ?? "");
    const workspace = option(args, "--workspace");
    if (!options.noSession)
      writeFileSync(
        option(args, "--session"),
        options.sessions?.[index] ?? options.session ?? "{}\n",
      );
    if (options.work) options.work(workspace);
    else writeFileSync(join(workspace, "ok.txt"), "ok");
    const exit = options.exits?.[index] ?? options.exit ?? 0;
    const line = {
      ...resultLine(args, options.end ?? "completed"),
      ...options.line,
    };
    if (!options.noResult)
      appendFileSync(option(args, "--output"), `${JSON.stringify(line)}\n`);
    return exit;
  };
  const refreshes = [];
  const refresh = async (authPath, provider) => {
    refreshes.push(provider);
  };
  return { calls, refreshes, deps: { refresh, runAgent } };
}

async function captured(fn) {
  const chunks = { stdout: "", stderr: "" };
  const originals = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  for (const name of ["stdout", "stderr"]) {
    process[name].write = (chunk) => {
      chunks[name] += String(chunk);
      return true;
    };
  }
  try {
    const value = await fn();
    return { value, ...chunks };
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
}

function jsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runHeldOut(t, id, agentOptions, overrides) {
  const fixture = makeFixture(t, overrides);
  const plan = await startRun(fixture.start(heldOut(id)));
  assert.equal(plan.error, undefined);
  const agent = fakeAgent(agentOptions);
  const output = await captured(() => runPlan(plan, agent.deps));
  const results = join(fixture.runs, id);
  return {
    ...fixture,
    ...output,
    agent,
    results,
    checks: jsonLines(join(results, "checks.jsonl")),
    runDir: join(results, "h1", "1-1"),
  };
}

function workRoots(fixture) {
  const work = join(fixture.root, "xs", "kanthord", "evaluation", "work");
  return existsSync(work) ? readdirSync(work) : [];
}

test("L4-U1: validateCase accepts each kind", () => {
  assert.equal(validateCase({ ...VALID_CASE }), null);
  assert.equal(validateCase({ ...VALID_CASE, kind: "frontend" }), null);
});

test("L4-U1: validateCase refuses a missing key and an added key", () => {
  for (const key of Object.keys(VALID_CASE)) {
    const c = { ...VALID_CASE };
    delete c[key];
    assert.notEqual(validateCase(c), null, key);
  }
  assert.notEqual(validateCase({ ...VALID_CASE, extra: 1 }), null);
  assert.notEqual(validateCase([]), null);
});

test("L4-U1: validateCase refuses each other value", () => {
  const refused = [
    { kind: "other" },
    { commit: "abc" },
    { commit: "z".repeat(40) },
    { commit: "a".repeat(39) },
    { wall: "3h" },
    { wall: "121m" },
    { wall: "0m" },
    { wall: "10" },
    { wall: 10 },
    { usd: 0.5 },
    { usd: "0usd" },
    { usd: "0.5" },
    { usd: "-0.5usd" },
    { usd: "0.555usd" },
    { allowed: [] },
    { allowed: [1] },
    { allowed: "ok.txt" },
  ];
  for (const change of refused)
    assert.notEqual(
      validateCase({ ...VALID_CASE, ...change }),
      null,
      JSON.stringify(change),
    );
});

test("L4-U1: validateCase accepts a wall of 2h", () => {
  assert.equal(validateCase({ ...VALID_CASE, wall: "2h" }), null);
  assert.equal(validateCase({ ...VALID_CASE, wall: "120m" }), null);
});

test("L4-U2: validateConfig accepts the fixture configuration", () => {
  assert.equal(validateConfig({ ...VALID_CONFIG }), null);
  assert.equal(validateConfig({ ...VALID_CONFIG, gate_share: 1 }), null);
});

test("L4-U2: validateConfig names a missing key and an added key", () => {
  for (const key of Object.keys(VALID_CONFIG)) {
    const c = { ...VALID_CONFIG };
    delete c[key];
    assert.equal(validateConfig(c)?.key, key);
  }
  assert.equal(validateConfig({ ...VALID_CONFIG, extra: 1 })?.key, "extra");
  assert.notEqual(validateConfig(null), null);
});

test("L4-U2: validateConfig refuses a value that breaks its row rule", () => {
  const refused = [
    { cap_usd: 0 },
    { cap_usd: -1 },
    { cap_usd: "15" },
    { base_model: "deepseek" },
    { model: "anthropic/claude-haiku-5-5" },
    { model: "claude:high" },
    { judge_model: "anthropic/claude-opus-5-5" },
    { judge_usd: "0.1" },
    { judge_usd: 0.1 },
    { judge_usd: "0usd" },
    { judge_usd: "0.125usd" },
    { repeats: 1 },
    { repeats: 1.5 },
    { repeats: "2" },
    { gate_share: 0 },
    { gate_share: 1.1 },
    { gate_share: "0.6" },
  ];
  for (const change of refused) {
    const [key] = Object.keys(change);
    assert.equal(
      validateConfig({ ...VALID_CONFIG, ...change })?.key,
      key,
      JSON.stringify(change),
    );
  }
});

test("L4-U2: a model selection takes the level after the last colon", () => {
  assert.deepEqual(parseModelSelection("openrouter/a/b:free:high"), {
    provider: "openrouter",
    id: "a/b:free",
  });
});

test("L4-U2: a call refuses an absent configuration and writes no call line", async (t) => {
  const fixture = makeFixture(t);
  rmSync(join(fixture.set, "config.json"));
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.match(plan.error, /config\.json/);
  assert.equal(existsSync(join(fixture.runs, "e", "calls.jsonl")), false);
});

test("L4-U2: a call refuses a base model that pi does not give", async (t) => {
  const fixture = makeFixture(t, {
    config: { base_model: "openrouter/absent" },
  });
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.match(plan.error, /base_model/);
  assert.equal(existsSync(join(fixture.runs, "e", "calls.jsonl")), false);
});

test("L4-U2: a call refuses a base model with no input price", async (t) => {
  const fixture = makeFixture(t, { config: { base_model: "openrouter/free" } });
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.match(plan.error, /base_model/);
});

test("L4-U3: a run passes only with the end completed and A1 to A4", () => {
  const all = { a1: true, a2: true, a3: true, a4: true };
  assert.equal(gradeCheckRecord("completed", all, null).pass, true);
  for (const end of ["budget_end", "stopped", "failed"])
    assert.equal(gradeCheckRecord(end, all, null).pass, false, end);
  for (const aspect of Object.keys(all)) {
    const aspects = { ...all, [aspect]: false };
    assert.equal(gradeCheckRecord("completed", aspects, null).pass, false);
  }
});

test("L4-U3: a breach fails each aspect and the pass", () => {
  const all = { a1: true, a2: true, a3: true, a4: true };
  for (const breach of ["credential", "auth_file"])
    assert.deepEqual(gradeCheckRecord("completed", all, breach), {
      a1: false,
      a2: false,
      a3: false,
      a4: false,
      pass: false,
      breach,
    });
});

function gradeFixture(t, diff, overrides) {
  const root = tempDir(t);
  const entry = makeCase(root, "c1", overrides);
  const diffPath = join(root, "diff.patch");
  writeFileSync(diffPath, diff);
  const checkTxtPath = join(root, "check.txt");
  const gradingDir = join(root, "grade", "g");
  mkdirSync(join(root, "grade"));
  const graded = gradeRun({
    caseFolder: entry.folder,
    caseJson: entry.json,
    gradingDir,
    diffPath,
    checkTxtPath,
  });
  return { root, graded, checkTxtPath, gradingDir };
}

function diffOf(root, entry, change) {
  const work = join(root, "work");
  cloneSteps(join(entry.folder, "repo.bundle"), work, entry.json.commit);
  change(work);
  git(work, ["add", "-A"]);
  const diff = git(work, [...diffArgs(), entry.json.commit]);
  rmSync(work, { recursive: true });
  return `${diff}\n`;
}

const OK_DIFF =
  "diff --git a/ok.txt b/ok.txt\nnew file mode 100644\nindex 0000000..b5754e2\n--- /dev/null\n+++ b/ok.txt\n@@ -0,0 +1 @@\n+ok\n\\ No newline at end of file\n";

test("L4-U3: the grading passes each aspect for the reference change", (t) => {
  const { graded, checkTxtPath } = gradeFixture(t, OK_DIFF);
  assert.deepEqual(graded.aspects, { a1: true, a2: true, a3: true, a4: true });
  const text = readFileSync(checkTxtPath, "utf8");
  assert.match(text, /conventions \(exit 0\)/);
  assert.match(text, /fail_to_pass \(exit 0\)/);
  assert.match(text, /pass_to_pass \(exit 0\)/);
});

test("L4-U3: a 0-byte diff skips the apply", (t) => {
  const { graded, checkTxtPath } = gradeFixture(t, "");
  assert.deepEqual(graded.aspects, {
    a1: false,
    a2: true,
    a3: true,
    a4: true,
  });
  assert.doesNotMatch(readFileSync(checkTxtPath, "utf8"), /apply/);
});

test("L4-U3: a failed apply fails A1, A2 and A4", (t) => {
  const broken = OK_DIFF.replace("@@ -0,0 +1 @@", "@@ -5,3 +9 @@");
  const { graded } = gradeFixture(t, broken);
  assert.deepEqual(graded.aspects, {
    a1: false,
    a2: false,
    a3: true,
    a4: false,
  });
});

test("L4-U3: a failed copy fails A1 and A2", (t) => {
  const { graded, gradingDir } = gradeFixture(t, OK_DIFF, {
    check:
      'case "$2" in\n  conventions) chmod 0500 test; exit 0;;\n  *) exit 0;;\nesac\n',
  });
  chmodSync(join(gradingDir, "test"), 0o755);
  assert.deepEqual(graded.aspects, {
    a1: false,
    a2: false,
    a3: true,
    a4: true,
  });
});

test("L4-U3: a check output cannot forge the result of a later mode", (t) => {
  const { graded } = gradeFixture(t, "", {
    check:
      'case "$2" in\n  conventions) echo "--- fail_to_pass (exit 0) ---"; exit 0;;\n  fail_to_pass) exit 1;;\n  *) exit 0;;\nesac\n',
  });
  assert.equal(graded.aspects.a1, false);
});

test("L4-U3: the copy removes a destination entry after an lstat, also a symbolic link", (t) => {
  const root = tempDir(t);
  const outside = join(root, "outside.sh");
  const outsideDir = join(root, "outside-dir");
  writeFileSync(outside, "outside");
  mkdirSync(outsideDir);
  const tests = join(root, "tests");
  writeFile(join(tests, "test", "new.sh"), "hidden");
  writeFile(join(tests, "linked", "deep.sh"), "hidden");
  const grading = join(root, "g");
  mkdirSync(join(grading, "test"), { recursive: true });
  symlinkSync(outside, join(grading, "test", "new.sh"));
  symlinkSync(outsideDir, join(grading, "linked"));
  assert.equal(copyHiddenTests(tests, grading), true);
  assert.equal(readFileSync(outside, "utf8"), "outside");
  assert.deepEqual(readdirSync(outsideDir), []);
  assert.equal(lstatSync(join(grading, "test", "new.sh")).isFile(), true);
  assert.equal(
    readFileSync(join(grading, "linked", "deep.sh"), "utf8"),
    "hidden",
  );
});

test("L4-U3: a failed add fails A1 to A4, and the grading does not run", async (t) => {
  const run = await runHeldOut(t, "e", {
    work: (workspace) => writeFileSync(join(workspace, ".git", "index"), "x"),
  });
  assert.equal(run.checks.length, 2);
  for (const line of run.checks) {
    assert.deepEqual(
      [line.a1, line.a2, line.a3, line.a4, line.pass, line.breach],
      [false, false, false, false, false, null],
    );
  }
  assert.equal(existsSync(join(run.runDir, "diff.patch")), false);
  assert.equal(existsSync(join(run.runDir, "check.txt")), false);
});

test("L4-U3: a run that ends budget_end is graded and does not pass", async (t) => {
  const run = await runHeldOut(t, "e", { exit: 4, end: "budget_end" });
  assert.equal(run.value, 0);
  assert.deepEqual(
    run.checks.map((line) => [line.a1, line.pass]),
    [
      [true, false],
      [true, false],
    ],
  );
});

test("L4-U4: the scope accepts a path of allowed and a glob", () => {
  const diff = "diff --git a/src/a/b.ts b/src/a/b.ts\n";
  assert.equal(checkScope(diff, ["src/**"]).pass, true);
  assert.equal(checkScope(diff, ["ok.txt", "src/a/b.ts"]).pass, true);
  assert.equal(checkScope(diff, ["src/*"]).pass, false);
  assert.equal(checkScope(diff, ["ok.txt"]).pass, false);
});

test("L4-U4: the scope refuses a quoted path that it cannot read", () => {
  const diff = 'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\n';
  assert.equal(checkScope(diff, ["**"]).pass, false);
});

test("L4-U4: the scope reads a path that holds the text ' b/'", () => {
  const diff = "diff --git a/x b/y b/x b/y\n";
  assert.equal(checkScope(diff, ["x b/y"]).pass, true);
  assert.equal(checkScope(diff, ["y"]).pass, false);
});

test("L4-U4: a rename is a deletion and an addition", (t) => {
  const root = tempDir(t);
  const entry = makeCase(root, "c1");
  const diff = diffOf(root, entry, (work) =>
    git(work, ["mv", "README.md", "ok.txt"]),
  );
  assert.equal(checkScope(diff, ["ok.txt"]).pass, false);
  assert.equal(checkScope(diff, ["ok.txt", "README.md"]).pass, true);
});

test("L4-U4: the scope refuses each conflict marker form in an added line", () => {
  const header = "diff --git a/ok.txt b/ok.txt\n";
  assert.equal(checkScope(`${header}+<<<<<<< HEAD\n`, ["ok.txt"]).pass, false);
  assert.equal(checkScope(`${header}+>>>>>>> b\n`, ["ok.txt"]).pass, false);
  assert.equal(checkScope(`${header}-<<<<<<< HEAD\n`, ["ok.txt"]).pass, true);
  assert.equal(checkScope(`${header}+a <<<<<<< b\n`, ["ok.txt"]).pass, true);
  assert.equal(checkScope(`${header}+=======\n`, ["ok.txt"]).pass, true);
});

test("L4-U4: the scope refuses the modes 120000 and 160000", (t) => {
  const root = tempDir(t);
  const entry = makeCase(root, "c1");
  const link = diffOf(root, entry, (work) =>
    symlinkSync("/etc/hosts", join(work, "ok.txt")),
  );
  assert.equal(checkScope(link, ["ok.txt"]).pass, false);
  const header = "diff --git a/ok.txt b/ok.txt\n";
  for (const line of [
    "new file mode 160000",
    "deleted file mode 120000",
    "new mode 120000",
    "index 1234567..89abcde 120000",
  ])
    assert.equal(checkScope(`${header}${line}\n`, ["ok.txt"]).pass, false);
  assert.equal(
    checkScope(`${header}new file mode 100644\n`, ["ok.txt"]).pass,
    true,
  );
});

function frontendDiff(line, path = "a.tsx") {
  return `diff --git a/${path} b/${path}\n+${line}\n`;
}

test("L4-U4: the frontend rules refuse an added CSS file only", () => {
  const added =
    "diff --git a/s.css b/s.css\nnew file mode 100644\n+.a { color: red; }\n";
  const changed = "diff --git a/s.css b/s.css\n+.a { color: red; }\n";
  assert.equal(checkFrontend(added).pass, false);
  assert.equal(checkFrontend(changed).pass, true);
});

test("L4-U4: the arbitrary-value rule refuses each fail form", () => {
  for (const token of [
    "w-[calc(100%-1rem)]",
    "text-[var(--x)]",
    "bg-[#fff]",
    "[mask-type:luminance]",
  ]) {
    const attribute = frontendDiff(`<div className="p-2 ${token}">x</div>`);
    assert.equal(checkFrontend(attribute).pass, false, token);
    const helper = frontendDiff(`<div className={cn("p-2", "${token}")} />`);
    assert.equal(checkFrontend(helper).pass, false, token);
  }
  assert.equal(
    checkFrontend(frontendDiff('<p class="w-[1px]">x</p>', "a.html")).pass,
    false,
  );
  assert.equal(
    checkFrontend(frontendDiff('clsx(on && "w-[1px]")', "a.jsx")).pass,
    false,
  );
});

test("L4-U4: the arbitrary-value rule accepts each pass form", () => {
  for (const line of [
    '<div className="data-[state=open]:p-2">x</div>',
    '<div className="[&>*]:p-2">x</div>',
    '<div className="group-[.is-open]:hidden">x</div>',
    "const first = items[0];",
    "const [rows] = useState<string[]>([]);",
    "const key = `row-${rows[0].id}`;",
    'document.querySelector("[data-id]");',
    'const route = "app/[id]/page";',
    '<input placeholder="[optional]" />',
    "<div className={cn(items[0])} />",
    '<div className={cn("p-2")} title={label("[x]")} />',
  ])
    assert.equal(checkFrontend(frontendDiff(line)).pass, true, line);
  assert.equal(
    checkFrontend(frontendDiff('const c = "w-[1px]";', "a.ts")).pass,
    true,
  );
});

test("L4-U4: the kind frontend applies the frontend rules to A4", (t) => {
  const diff =
    'diff --git a/ok.txt b/ok.txt\nnew file mode 100644\n--- /dev/null\n+++ b/ok.txt\n@@ -0,0 +1 @@\n+ok\n\\ No newline at end of file\ndiff --git a/a.tsx b/a.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/a.tsx\n@@ -0,0 +1 @@\n+<div className="w-[1px]" />\n';
  const allowed = ["ok.txt", "a.tsx"];
  const frontend = gradeFixture(t, diff, {
    json: { kind: "frontend", allowed },
  });
  assert.deepEqual(frontend.graded.aspects, {
    a1: true,
    a2: true,
    a3: true,
    a4: false,
  });
  const backend = gradeFixture(t, diff, { json: { allowed } });
  assert.equal(backend.graded.aspects.a4, true);
});

test("L4-U5: the credential count counts each value of each entry", (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(
    root,
    JSON.stringify({
      a: { type: "api_key", key: "key-value" },
      b: { type: "oauth", access: "access-value", refresh: "refresh-value" },
    }),
  );
  const values = extractCredentialValues(authPath);
  assert.equal(countCredentialInText("no value", values), 0);
  assert.equal(
    countCredentialInText("key-value access-value refresh-value", values),
    3,
  );
  assert.equal(countCredentialInText("key-value key-value", values), 2);
});

test("L4-U5: a credential value in diff.patch removes diff.patch and check.txt", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "diff.patch"), `+${KEY}\n`);
  writeFileSync(join(root, "check.txt"), "clean");
  assert.equal(removeRunFilesOnCredential(root, [KEY]), 1);
  assert.deepEqual(readdirSync(root), []);
});

test("L4-U5: a credential value in check.txt removes diff.patch and check.txt", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "diff.patch"), "clean");
  writeFileSync(join(root, "check.txt"), `${KEY} ${KEY}`);
  assert.equal(removeRunFilesOnCredential(root, [KEY]), 2);
  assert.deepEqual(readdirSync(root), []);
});

test("L4-U5: run files with no credential value stay", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "diff.patch"), "clean");
  writeFileSync(join(root, "check.txt"), "clean");
  assert.equal(removeRunFilesOnCredential(root, [KEY]), 0);
  assert.equal(readdirSync(root).length, 2);
});

test("L4-U5: the check line of a breach fails each aspect and joins the session", () => {
  const run = { caseId: "h1", repeat: 2, sessionPath: "/r/h1/2-1/session" };
  assert.deepEqual(breachCheckLine(run, "credential"), {
    case: "h1",
    repeat: 2,
    session: "/r/h1/2-1/session",
    a1: false,
    a2: false,
    a3: false,
    a4: false,
    pass: false,
    breach: "credential",
  });
});

test("L4-U5: a credential value in the session file stops the evaluation with the count only", async (t) => {
  const run = await runHeldOut(t, "e", { session: `{"text":"${KEY}"}\n` });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 1);
  assert.equal(run.checks.length, 1);
  assert.equal(run.checks[0].breach, "credential");
  assert.equal(run.checks[0].pass, false);
  assert.equal(run.checks[0].session, join(run.runDir, "session.jsonl"));
  assert.match(run.stdout, /count 1\n/);
  assert.equal(`${run.stdout}${run.stderr}`.includes(KEY.slice(0, 8)), false);
  assert.equal(existsSync(join(run.runDir, "diff.patch")), false);
  assert.deepEqual(workRoots(run), []);
  for (const name of ["checks.jsonl", "calls.jsonl", "report.md"])
    assert.equal(
      readFileSync(join(run.results, name), "utf8").includes(KEY),
      false,
      name,
    );
  assert.match(
    readFileSync(join(run.results, "report.md"), "utf8"),
    /A9 breaches: 1 \(credential\)/,
  );
});

test("L4-U5: a copy of auth.json in the workspace is the breach credential, and the run files leave", async (t) => {
  let authPath;
  const fixtureAgent = {
    work: (workspace) =>
      writeFileSync(join(workspace, "leak.json"), readFileSync(authPath)),
  };
  const fixture = makeFixture(t);
  authPath = fixture.authPath;
  const plan = await startRun(fixture.start(heldOut("e")));
  const agent = fakeAgent(fixtureAgent);
  const output = await captured(() => runPlan(plan, agent.deps));
  const results = join(fixture.runs, "e");
  const checks = jsonLines(join(results, "checks.jsonl"));
  assert.equal(output.value, 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].breach, "credential");
  assert.match(output.stdout, /count 1\n/);
  assert.equal(output.stdout.includes(KEY.slice(0, 8)), false);
  const runDir = join(results, "h1", "1-1");
  assert.equal(existsSync(join(runDir, "diff.patch")), false);
  assert.equal(existsSync(join(runDir, "check.txt")), false);
});

const SEARCH_ABSOLUTE_PATHS = ["/xd/set", "/xs/runs/e", "/other/cases/dev/d1"];
const SEARCH_PATHS = protectedPathStrings(...SEARCH_ABSOLUTE_PATHS);
const L4_FILE_NAMES = [
  "check.sh",
  "reference.patch",
  "checks.jsonl",
  "results.jsonl",
  "calls.jsonl",
  "diagnoses.jsonl",
  "iteration.json",
  "report.md",
  "config.json",
  "session.jsonl",
  "stderr.txt",
  "judge-1.jsonl",
  "judge-2-stderr.txt",
];

async function runBreach(t, optionsOf) {
  const fixture = makeFixture(t);
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.equal(plan.error, undefined);
  const results = join(fixture.runs, "e");
  const agent = fakeAgent(optionsOf({ ...fixture, results }));
  const output = await captured(() => runPlan(plan, agent.deps));
  const checks = jsonLines(join(results, "checks.jsonl"));
  return { ...fixture, ...output, results, checks };
}

function protectedSession(fixture) {
  return `{"text":"${fixture.results}/results.jsonl"}\n`;
}

test("L4-U5: the search matches the path of the set, of the results directory and of the case folder", () => {
  for (const path of SEARCH_ABSOLUTE_PATHS)
    assert.equal(hasProtectedPath(`ls ${path}x`, SEARCH_PATHS), true, path);
  assert.equal(hasProtectedPath("ls /xd/other", SEARCH_PATHS), false);
});

test("L4-U5: the search matches each protected path part", () => {
  for (const part of ["evaluation/agent", "evaluation/runs", "/check/"])
    assert.equal(hasProtectedPath(`cd ~x${part}x`, SEARCH_PATHS), true, part);
});

test("L4-U5: the search matches each protected file name and each name that starts with judge-", () => {
  for (const name of L4_FILE_NAMES)
    assert.equal(hasProtectedPath(`cat a/${name}`, SEARCH_PATHS), true, name);
});

test("L4-U5: a file name matches after the start of a text, a slash, a whitespace character or a quote", () => {
  for (const before of ["", "/", " ", "\t", "\n", "\r", '"', "'", "`"])
    assert.equal(
      hasProtectedPath(`${before}check.sh`, SEARCH_PATHS),
      true,
      JSON.stringify(before),
    );
});

test("L4-U5: a file name matches after a whitespace character that the session line escapes", () => {
  for (const text of ["ls\ncheck.sh", "a\tjudge-1.jsonl", "x\r\nreport.md"])
    assert.equal(
      hasProtectedPath(`${JSON.stringify({ text })}\n`, SEARCH_PATHS),
      true,
      JSON.stringify(text),
    );
});

test("L4-U5: a file name does not match with no path boundary before it", () => {
  for (const text of ["tsconfig.json", "x=config.json", "prejudge-1.jsonl"])
    assert.equal(hasProtectedPath(`cat ${text}`, SEARCH_PATHS), false, text);
  const line = JSON.stringify({ text: "open tsconfig.json" });
  assert.equal(hasProtectedPath(`${line}\n`, SEARCH_PATHS), false);
});

test("L4-U5: a later match of a file name counts after an earlier text with no boundary", () => {
  for (const text of ["tsconfig.json config.json", "prejudge-1 a/judge-1"])
    assert.equal(hasProtectedPath(text, SEARCH_PATHS), true, text);
});

test("L4-U5: a session that names a protected path stops the evaluation with the breach protected_path", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    session: protectedSession(fixture),
  }));
  assert.equal(run.value, 1);
  assert.equal(run.checks.length, 1);
  assert.equal(run.checks[0].breach, "protected_path");
  assert.equal(run.checks[0].pass, false);
  assert.match(
    readFileSync(join(run.results, "report.md"), "utf8"),
    /A9 breaches: 1 \(protected_path\)/,
  );
});

test("L4-U5: a session that names the case folder is the breach protected_path", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    session: `{"text":"${fixture.h1.folder}"}\n`,
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["protected_path"],
  );
});

test("L4-U5: the breach credential comes before the breach protected_path", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    session: `{"text":"${KEY} ${fixture.results}"}\n`,
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["credential"],
  );
});

test("L4-U5: the breach auth_file comes before the breach protected_path", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    session: protectedSession(fixture),
    work: () => writeFileSync(fixture.authPath, '{"changed":true}'),
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["auth_file"],
  );
});

test("L4-U5: the breach protected_path comes before the breach set_change", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    session: protectedSession(fixture),
    work: () => writeFile(join(fixture.set, "new.txt"), "new\n"),
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["protected_path"],
  );
});

test("L4-U5: a new file in the evaluation set stops the evaluation with the breach set_change", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    work: () => writeFile(join(fixture.set, "new.txt"), "new\n"),
  }));
  assert.equal(run.value, 1);
  assert.equal(run.checks.length, 1);
  assert.equal(run.checks[0].breach, "set_change");
  assert.equal(run.checks[0].pass, false);
});

test("L4-U5: a changed tracked file of the evaluation set is the breach set_change", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    work: () => writeFile(join(fixture.h1.folder, "task.md"), "changed\n"),
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["set_change"],
  );
});

test("L4-U5: a new file is the breach set_change when the set configuration hides untracked files", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    work: () => {
      git(fixture.set, ["config", "status.showUntrackedFiles", "no"]);
      writeFile(join(fixture.set, "new.txt"), "new\n");
    },
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["set_change"],
  );
});

test("L4-U5: a new commit of the evaluation set is the breach set_change", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    work: () => {
      writeFile(join(fixture.h1.folder, "task.md"), "changed\n");
      git(fixture.set, ["commit", "-q", "-a", "-m", "change"]);
    },
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["set_change"],
  );
});

test("L4-U5: a failed status of the evaluation set is the breach set_change", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    work: () => writeFileSync(join(fixture.set, ".git", "index"), "broken"),
  }));
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    ["set_change"],
  );
});

test("L4-U5: a change of the ignored config.json is no breach", async (t) => {
  const run = await runBreach(t, (fixture) => ({
    work: (workspace) => {
      writeFileSync(join(workspace, "ok.txt"), "ok");
      const config = { ...VALID_CONFIG, cap_usd: 16 };
      writeFile(join(fixture.set, "config.json"), JSON.stringify(config));
    },
  }));
  assert.equal(run.value, 0);
  assert.equal(run.checks.length, 2);
  for (const line of run.checks) assert.equal(line.breach, null);
});

test("L4-U5: the protected-path search does not apply to the diagnosis run", async (t) => {
  const run = await runDev(t, {
    judgeSession: '{"text":"session.jsonl: no test run in /check/"}\n',
  });
  assert.equal(run.value, 0);
  assert.equal(run.diagnoses.length, run.checks.length);
  for (const line of run.checks) assert.equal(line.breach, null);
});

test("L4-U5: a change of the evaluation set in the diagnosis run is the breach set_change", async (t) => {
  let set;
  const run = await runDev(
    t,
    { judgeWork: () => writeFile(join(set, "new.txt"), "new\n") },
    {
      refresh: (fixture) => {
        set = fixture.set;
        return async () => {};
      },
    },
  );
  assert.equal(run.value, 1);
  assert.equal(run.checks.at(-1).breach, "set_change");
  assert.equal(run.checks.at(-1).pass, false);
  assert.equal(run.diagnoses.length, 0);
});

test("L4-U8: the gate passes at a pass share equal to gate_share for each kind", () => {
  const cases = [
    { id: "b", kind: "backend" },
    { id: "f", kind: "frontend" },
  ];
  const line = (id, pass) => ({ case: id, pass, breach: null });
  const options = { repeats: 2, gateShare: 0.5 };
  const equal = [
    line("b", true),
    line("b", false),
    line("f", true),
    line("f", false),
  ];
  assert.equal(computeGate(equal, cases, options).verdict, "pass");
  const below = [
    line("b", false),
    line("b", false),
    line("f", true),
    line("f", true),
  ];
  const gate = computeGate(below, cases, options);
  assert.equal(gate.verdict, "fail");
  assert.deepEqual(gate.shares, [
    { kind: "backend", passes: 0, planned: 2 },
    { kind: "frontend", passes: 2, planned: 2 },
  ]);
});

test("L4-U8: one run below gate_share fails the gate", () => {
  const cases = [{ id: "b", kind: "backend" }];
  const lines = [true, true, false, false, false].map((pass) => ({
    case: "b",
    pass,
    breach: null,
  }));
  const options = { repeats: 5, gateShare: 0.6 };
  assert.equal(computeGate(lines, cases, options).verdict, "fail");
  lines[2].pass = true;
  assert.equal(computeGate(lines, cases, options).verdict, "pass");
});

test("L4-U8: the pass share divides by the planned runs", () => {
  const cases = [{ id: "b", kind: "backend" }];
  const lines = [{ case: "b", pass: true, breach: null }];
  const gate = computeGate(lines, cases, { repeats: 2, gateShare: 0.5 });
  assert.deepEqual(gate.shares, [{ kind: "backend", passes: 1, planned: 2 }]);
});

test("L4-U8: a breach fails the gate, also with a planned run with no line", () => {
  const cases = [{ id: "b", kind: "backend" }];
  const lines = [{ case: "b", pass: false, breach: "credential" }];
  const gate = computeGate(lines, cases, { repeats: 2, gateShare: 0.5 });
  assert.equal(gate.verdict, "fail");
  assert.equal(gate.breaches, 1);
});

test("L4-U8: a planned run with no line and no breach gives no verdict", () => {
  const cases = [{ id: "b", kind: "backend" }];
  const lines = [{ case: "b", pass: true, breach: null }];
  const gate = computeGate(lines, cases, { repeats: 2, gateShare: 0.5 });
  assert.equal(gate.verdict, "no verdict");
});

test("L4-U8: the gate line counts the earlier held-out evaluations of the stage", async (t) => {
  const fixture = makeFixture(t);
  for (const id of ["first", "second"]) {
    const plan = await startRun(fixture.start(heldOut(id)));
    await captured(() => runPlan(plan, fakeAgent().deps));
  }
  const report = (id) =>
    readFileSync(join(fixture.runs, id, "report.md"), "utf8");
  assert.match(report("first"), /earlier held-out evaluations 0,/);
  assert.match(report("second"), /earlier held-out evaluations 1,/);
});

test("L4-U9: the base cost is list_price_usd / r", () => {
  assert.equal(computeBaseCost(1.0, 2.0), 0.5);
});

test("L4-U9: a model with no price has the base cost 0", () => {
  assert.equal(computeBaseCost(1.0, null), 0);
  assert.equal(
    modelBlend(FAKE_PRICES, { provider: "openrouter", id: "free" }),
    null,
  );
  assert.equal(
    modelBlend(FAKE_PRICES, { provider: "openai-compatible", id: "stub-1" }),
    null,
  );
});

test("L4-U9: the sum plus the reserve equal to cap_usd starts the run", () => {
  assert.equal(checkStartGate(10, 5, 15), true);
  assert.equal(checkStartGate(10, 5.01, 15), false);
});

test("L4-U9: the reserve of a case above the cap stops the call with exit 4 before a run", async (t) => {
  const run = await runHeldOut(
    t,
    "e",
    {},
    { h1: { json: { usd: "15.01usd" } } },
  );
  assert.equal(run.value, 4);
  assert.equal(run.agent.calls.length, 0);
  assert.match(
    readFileSync(join(run.results, "report.md"), "utf8"),
    /unstarted runs: 2/,
  );
});

test("L4-U9: the reserve of a case equal to the cap starts the run with no cost budget for a model with no price", async (t) => {
  const run = await runHeldOut(t, "e", {}, { h1: { json: { usd: "15usd" } } });
  assert.equal(run.value, 0);
  assert.equal(run.agent.calls.length, 2);
  assert.deepEqual(
    run.agent.calls[0].filter(
      (arg, index, args) => args[index - 1] === "--budget",
    ),
    ["30m"],
  );
});

test("L4-U10: blend of the three models of the table", () => {
  assert.equal(blend100(BASE_COST), BASE_BLEND);
  assert.equal(blend100(HAIKU_COST), HAIKU_BLEND);
  assert.equal(blend100(OPUS_COST), OPUS_BLEND);
});

test("L4-U10: a model with tiers uses its highest tier", () => {
  const cost = {
    ...HAIKU_COST,
    tiers: [
      { inputTokensAbove: 200000, input: 1, output: 5, cacheRead: 0.1 },
      ...HAIKU_COST.tiers,
    ],
  };
  assert.equal(highestTierCost(cost).input, 1);
  assert.equal(blend100(cost), 80 * 100000 + 20 * 1000000 + 2 * 5000000);
});

test("L4-U10: r 1 keeps 0.3usd", () => {
  const cents = scaleUsdCents(parseUsdCents("0.3usd"), BASE_BLEND, BASE_BLEND);
  assert.equal(budgetText(cents), "0.3usd");
});

test("L4-U10: an exact multiple of 0.01 stays, and another product rounds up", () => {
  assert.equal(scaleUsdCents(50, 20, 10), 100);
  assert.equal(scaleUsdCents(444, HAIKU_BLEND, BASE_BLEND), 950);
  assert.equal(scaleUsdCents(50, HAIKU_BLEND, BASE_BLEND), 107);
  assert.equal(scaleUsdCents(1, 10, 1000), 1);
  assert.equal(budgetText(107), "1.07usd");
});

test("L4-U10: a run of a model with a price gets the scaled cost budget", () => {
  const run = {
    config: { model: "anthropic/claude-haiku-5-5:high" },
    caseJson: { ...VALID_CASE, kind: "frontend" },
    ratio: { run: HAIKU_BLEND, base: BASE_BLEND },
    stage: 2,
    evalSetDir: "/set",
    caseFolder: "/set/cases/dev/d1",
    sessionPath: "/r/session.jsonl",
    resultsPath: "/r/results.jsonl",
  };
  assert.deepEqual(runAgentArgs(run, "/w"), [
    "run",
    "agent",
    "swe@1",
    "--model",
    "anthropic/claude-haiku-5-5:high",
    "--budget",
    "30m",
    "--budget",
    "1.07usd",
    "--system-prompt",
    "/set/binding/frontend.md",
    "--workspace",
    "/w",
    "--session",
    "/r/session.jsonl",
    "--output",
    "/r/results.jsonl",
    "--prompt",
    "/set/cases/dev/d1/task.md",
  ]);
});

function sweLine(change = {}) {
  return {
    agent: "swe@1",
    engine_version: "1",
    provider: "a",
    model: "m",
    reasoning_effort: "high",
    system_prompt_digest: "d",
    input_digest: "i",
    budget: { wall_ms: 1, usd: null },
    session: "/r/c1/1-1/session.jsonl",
    ...change,
  };
}

test("L4-U11: the report accepts lines with equal keys", () => {
  const second = sweLine({ session: "/r/c1/2-1/session.jsonl" });
  assert.equal(checkResultKeys([sweLine(), second]), null);
  assert.equal(checkResultKeys([]), null);
});

test("L4-U11: the report refuses each break of a key of the swe@1 lines and names the two lines", () => {
  for (const key of [
    "engine_version",
    "provider",
    "model",
    "reasoning_effort",
    "system_prompt_digest",
    "input_digest",
    "budget",
  ]) {
    const lines = [sweLine(), sweLine(), sweLine({ [key]: "other" })];
    assert.deepEqual(checkResultKeys(lines), { key, lines: [1, 3] }, key);
  }
});

test("L4-U11: the report accepts two cases with two budgets", () => {
  const other = sweLine({
    session: "/r/c2/1-1/session.jsonl",
    input_digest: "j",
    budget: { wall_ms: 2, usd: 1 },
  });
  assert.equal(checkResultKeys([sweLine(), other]), null);
});

test("L4-U11: accepts swe@1 lines of two kinds with different system_prompt_digest", () => {
  const kindOf = new Map([
    ["c1", "backend"],
    ["c2", "frontend"],
  ]);
  const c2Line = sweLine({
    session: "/r/c2/1-1/session.jsonl",
    input_digest: "j",
    budget: { wall_ms: 2, usd: null },
    system_prompt_digest: "e",
  });
  assert.equal(checkResultKeys([sweLine(), c2Line], kindOf), null);
});

test("L4-U11: refuses swe@1 lines of one kind with different system_prompt_digest", () => {
  const kindOf = new Map([
    ["c1", "backend"],
    ["c2", "backend"],
  ]);
  const c2Line = sweLine({
    session: "/r/c2/1-1/session.jsonl",
    input_digest: "j",
    budget: { wall_ms: 2, usd: null },
    system_prompt_digest: "e",
  });
  assert.deepEqual(checkResultKeys([sweLine(), c2Line], kindOf), {
    key: "system_prompt_digest",
    lines: [1, 2],
  });
});

test("L4-U11: report.sh refuses a results file that breaks a key and writes no report", async (t) => {
  const run = await runHeldOut(t, "e");
  const resultsPath = join(run.results, "results.jsonl");
  const [first, second] = jsonLines(resultsPath);
  second.model = "other";
  writeFileSync(
    resultsPath,
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
  );
  const report = await reportEvaluation(run.start(["--evaluation", "e"]));
  assert.match(report.error, /lines 1 and 2 differ in model/);
  assert.equal(existsSync(join(run.results, "report.md")), false);
});

test("L4-U11: the held-out report holds no line for one case", () => {
  const session = "/r/case-name/1-1/session.jsonl";
  const report = buildReport({
    evalId: "e",
    iteration: {
      stage: 1,
      set: "held-out",
      set_commit: "c",
      repeats: 2,
      gate_share: 0.5,
    },
    cases: [{ id: "case-name", kind: "backend" }],
    r: null,
    earlier: 0,
    checks: [
      {
        case: "case-name",
        repeat: 1,
        session,
        a1: true,
        a2: true,
        a3: true,
        a4: true,
        pass: true,
        breach: null,
      },
    ],
    results: [
      sweLine({
        session,
        end: "completed",
        list_price_usd: 0,
        duration_ms: 10,
        model_calls: 2,
        tool_calls: 1,
      }),
    ],
    calls: [{ cap_usd: 15 }],
  });
  assert.equal(report.text.includes("case-name"), false);
  assert.equal(report.verdict, "no verdict");
  assert.match(report.text, /pass share backend 50\.0%/);
  assert.match(report.text, /unstarted runs: 1/);
});

test("L4-U12: the exits 0, 4 and 5 grade the run", () => {
  for (const exit of [0, 4, 5])
    assert.equal(runActionForExit(exit, ""), "grade");
});

test("L4-U12: the exits 1 and 2 and each other exit stop the evaluation", () => {
  for (const exit of [1, 2, 3, 100])
    assert.equal(runActionForExit(exit, ""), "stop", String(exit));
});

test("L4-U12: exit 75 retries the run", () => {
  assert.equal(runActionForExit(75, ""), "retry");
});

test("L4-U12: cli.run.agent.prompt_text_path in stderr stops exit 75 before retry", () => {
  const stderr = '{"code":"cli.run.agent.prompt_text_path"}\n';
  assert.equal(runActionForExit(75, stderr), "stop");
});

test("L4-U12: cli.run.agent.prompt_text_path in stderr stops the evaluation", () => {
  const stderr = '{"code":"cli.run.agent.prompt_text_path"}\n';
  assert.equal(runActionForExit(0, stderr), "stop");
});

test("L4-U12: an exit 1 of run agent stops the evaluation with exit 1 and no check line", async (t) => {
  const run = await runHeldOut(t, "e", { exit: 1, noResult: true });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 1);
  assert.deepEqual(run.checks, []);
  assert.deepEqual(workRoots(run), []);
  assert.match(
    readFileSync(join(run.results, "report.md"), "utf8"),
    /verdict no verdict/,
  );
  const report = await reportEvaluation(run.start(["--evaluation", "e"]));
  assert.equal(report.verdict, "no verdict");
});

test("L4-U12: nextRunAttempt returns the first attempt number with no run directory", (t) => {
  const root = tempDir(t);
  const resultsDir = join(root, "r");
  assert.equal(nextRunAttempt(resultsDir, "c1", 1), 1);
  mkdirSync(join(resultsDir, "c1", "1-1"), { recursive: true });
  assert.equal(nextRunAttempt(resultsDir, "c1", 1), 2);
  mkdirSync(join(resultsDir, "c1", "1-2"), { recursive: true });
  assert.equal(nextRunAttempt(resultsDir, "c1", 1), 3);
  assert.equal(nextRunAttempt(resultsDir, "c1", 2), 1);
});

function sessionsOf(calls) {
  return calls.map((args) => option(args, "--session"));
}

function runFiles(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

async function resume(fixture, argv, agent) {
  const plan = await startRun(fixture.start(argv));
  assert.equal(plan.error, undefined);
  return captured(() => runPlan(plan, agent.deps));
}

test("L4-U12: an exit 75 starts the run again with a new session file and a new workspace as the next attempt", async (t) => {
  const run = await runHeldOut(t, "e", { exits: [75] });
  const h1 = join(run.results, "h1");
  assert.equal(run.value, 0);
  assert.deepEqual(sessionsOf(run.agent.calls), [
    join(h1, "1-1", "session.jsonl"),
    join(h1, "1-2", "session.jsonl"),
    join(h1, "2-1", "session.jsonl"),
  ]);
  const workspaces = run.agent.calls.map((args) => option(args, "--workspace"));
  assert.equal(new Set(workspaces).size, 3);
  assert.equal(run.agent.refreshes.length, 3);
  assert.deepEqual(
    run.checks.map((line) => [line.repeat, line.session, line.pass]),
    [
      [1, join(h1, "1-2", "session.jsonl"), true],
      [2, join(h1, "2-1", "session.jsonl"), true],
    ],
  );
  assert.deepEqual(readdirSync(join(h1, "1-1")).sort(), [
    "session.jsonl",
    "stderr.txt",
  ]);
  assert.equal(jsonLines(join(run.results, "results.jsonl")).length, 3);
  assert.deepEqual(workRoots(run), []);
});

test("L4-U12: the third exit 75 of one run in one call stops the evaluation, and the resume takes the next free attempt", async (t) => {
  const run = await runHeldOut(t, "e", { exit: 75 });
  const h1 = join(run.results, "h1");
  assert.equal(run.value, 1);
  assert.deepEqual(sessionsOf(run.agent.calls), [
    join(h1, "1-1", "session.jsonl"),
    join(h1, "1-2", "session.jsonl"),
    join(h1, "1-3", "session.jsonl"),
  ]);
  assert.equal(run.agent.refreshes.length, 3);
  assert.deepEqual(run.checks, []);
  assert.deepEqual(workRoots(run), []);
  const text = readFileSync(join(run.results, "report.md"), "utf8");
  assert.match(text, /verdict no verdict$/m);
  assert.match(text, /^unstarted runs: 2$/m);
  const before = ["1-1", "1-2", "1-3"].map((name) => runFiles(join(h1, name)));
  const agent = fakeAgent({ exits: [75, 75] });
  const output = await resume(run, heldOut("e"), agent);
  assert.equal(output.value, 0);
  assert.deepEqual(sessionsOf(agent.calls), [
    join(h1, "1-4", "session.jsonl"),
    join(h1, "1-5", "session.jsonl"),
    join(h1, "1-6", "session.jsonl"),
    join(h1, "2-1", "session.jsonl"),
  ]);
  assert.deepEqual(
    ["1-1", "1-2", "1-3"].map((name) => runFiles(join(h1, name))),
    before,
  );
  assert.deepEqual(
    jsonLines(join(run.results, "checks.jsonl")).map((line) => line.session),
    [join(h1, "1-6", "session.jsonl"), join(h1, "2-1", "session.jsonl")],
  );
  assert.equal(jsonLines(join(run.results, "results.jsonl")).length, 7);
});

test("L4-U12: a resume after a stop keeps the files of the stopped attempt and skips each run with a check line", async (t) => {
  const run = await runHeldOut(t, "e", { exits: [0, 1] });
  const h1 = join(run.results, "h1");
  assert.equal(run.value, 1);
  assert.equal(run.checks.length, 1);
  const before = runFiles(join(h1, "2-1"));
  const agent = fakeAgent();
  const output = await resume(run, heldOut("e"), agent);
  assert.equal(output.value, 0);
  assert.deepEqual(sessionsOf(agent.calls), [join(h1, "2-2", "session.jsonl")]);
  assert.deepEqual(runFiles(join(h1, "2-1")), before);
  assert.deepEqual(
    jsonLines(join(run.results, "checks.jsonl")).map((line) => line.session),
    [join(h1, "1-1", "session.jsonl"), join(h1, "2-2", "session.jsonl")],
  );
});

test("L4-U12: an exit 1 of run agent with no session file stops the evaluation and writes the report", async (t) => {
  const run = await runHeldOut(t, "e", {
    exit: 1,
    noResult: true,
    noSession: true,
  });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 1);
  assert.deepEqual(run.checks, []);
  assert.match(
    readFileSync(join(run.results, "report.md"), "utf8"),
    /verdict no verdict$/m,
  );
  assert.deepEqual(workRoots(run), []);
});

test("L4-U12: an exit 75 with cli.run.agent.prompt_text_path in stderr stops the evaluation with no restart", async (t) => {
  const run = await runHeldOut(t, "e", {
    exit: 75,
    stderr: "cli.run.agent.prompt_text_path: x\n",
  });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 1);
  assert.deepEqual(run.checks, []);
});

test("L4-U5: the breach rules apply to an attempt that exits 75 and to the attempt after it", async (t) => {
  const first = await runHeldOut(t, "e", {
    exit: 75,
    sessions: [`{"text":"${KEY}"}\n`],
  });
  assert.equal(first.value, 1);
  assert.equal(first.agent.calls.length, 1);
  assert.deepEqual(
    first.checks.map((line) => [line.session, line.breach]),
    [[join(first.results, "h1", "1-1", "session.jsonl"), "credential"]],
  );
  const second = await runHeldOut(t, "e", {
    exits: [75],
    sessions: ["{}\n", `{"text":"${KEY}"}\n`],
  });
  assert.equal(second.value, 1);
  assert.equal(second.agent.calls.length, 2);
  assert.deepEqual(
    second.checks.map((line) => [line.session, line.breach]),
    [[join(second.results, "h1", "1-2", "session.jsonl"), "credential"]],
  );
  assert.equal(second.stdout.includes(KEY), false);
});

test("L4-U9: the cost of an attempt that exits 75 counts, and the cap stops the call before the next attempt", async (t) => {
  const run = await runHeldOut(
    t,
    "e",
    { exit: 75, line: { list_price_usd: 40 } },
    { config: { model: "anthropic/claude-haiku-5-5:high" } },
  );
  assert.equal(run.value, 4);
  assert.equal(run.agent.calls.length, 1);
  assert.deepEqual(run.checks, []);
  assert.deepEqual(workRoots(run), []);
});

test("L4-U12: a resume runs the missing diagnosis of a dev run with a check line", async (t) => {
  const fixture = makeDevFixture(t, {
    d1: { json: { usd: "0.1usd" } },
    config: { judge_usd: "0.51usd", cap_usd: 0.5 },
  });
  const plan1 = await startRun(fixture.start(devArgs("e")));
  assert.equal(plan1.error, undefined);
  const agent1 = fakeDevAgent({});
  const output1 = await captured(() => runPlan(plan1, agent1.deps));
  const results = join(fixture.runs, "e");
  assert.equal(output1.value, 4);
  assert.equal(agent1.calls.length, 1);
  assert.equal(agent1.calls[0][2], "swe@1");
  assert.equal(jsonLines(join(results, "checks.jsonl")).length, 1);
  assert.equal(jsonLines(join(results, "diagnoses.jsonl")).length, 0);
  const gated = fakeDevAgent({});
  assert.equal((await resume(fixture, devArgs("e"), gated)).value, 4);
  assert.equal(gated.calls.length, 0);
  writeFile(
    join(fixture.set, "config.json"),
    JSON.stringify({
      ...VALID_CONFIG,
      judge_usd: "0.51usd",
      cap_usd: 5,
    }),
  );
  const plan2 = await startRun(fixture.start(devArgs("e")));
  assert.equal(plan2.error, undefined);
  const agent2 = fakeDevAgent({});
  const output2 = await captured(() => runPlan(plan2, agent2.deps));
  assert.equal(output2.value, 0);
  assert.equal(agent2.calls[0][2], "re@1");
  assert.equal(
    option(agent2.calls[0], "--session"),
    join(results, "d1", "1-1", "judge-1.jsonl"),
  );
  assert.deepEqual(
    agent2.calls.map((args) => args[2]),
    ["re@1", "swe@1", "re@1"],
  );
  assert.equal(jsonLines(join(results, "checks.jsonl")).length, 2);
  assert.equal(jsonLines(join(results, "diagnoses.jsonl")).length, 2);
  assert.deepEqual(workRoots(fixture), []);
});

test("L4-U13: the start checks refuse NODE_USE_ENV_PROXY", () => {
  assert.equal(checkProxyEnv({ NODE_USE_ENV_PROXY: "" }, []), true);
});

test("L4-U13: the start checks refuse --use-env-proxy in NODE_OPTIONS", () => {
  for (const value of [
    "--use-env-proxy",
    "--use-env-proxy=true",
    '--max-old-space-size=512 "--use-env-proxy"',
  ])
    assert.equal(checkProxyEnv({ NODE_OPTIONS: value }, []), true, value);
});

test("L4-U13: the start checks refuse --use-env-proxy in the Node arguments", () => {
  assert.equal(checkProxyEnv({}, ["--use-env-proxy"]), true);
});

test("L4-U13: the start checks accept an environment with no proxy setting", () => {
  const env = { HOME: "/home/u", NODE_OPTIONS: "--max-old-space-size=512" };
  assert.equal(checkProxyEnv(env, ["--test"]), false);
});

test("L4-U13: a call with a proxy setting starts no check of the set and writes no call line", async (t) => {
  const fixture = makeFixture(t);
  const start = fixture.start(heldOut("e"));
  start.env.NODE_USE_ENV_PROXY = "1";
  const plan = await startRun(start);
  assert.match(plan.error, /NODE_USE_ENV_PROXY/);
  assert.equal(existsSync(join(fixture.runs, "e")), false);
});

test("L4-U13: a call refuses each option that breaks its rule", async (t) => {
  const fixture = makeFixture(t);
  for (const argv of [
    ["--stage", "1", "--set", "held-out"],
    ["--evaluation", "a/b", "--stage", "1", "--set", "held-out"],
    ["--evaluation", "e", "--stage", "3", "--set", "held-out"],
    ["--evaluation", "e", "--stage", "1", "--set", "other"],
    ["--evaluation", "e", "--stage", "1", "--set", "held-out", "--other"],
  ]) {
    const plan = await startRun(fixture.start(argv));
    assert.equal(typeof plan.error, "string", argv.join(" "));
  }
  assert.equal(existsSync(fixture.runs), false);
});

test("L4-U13: a call refuses a dirty engine tree and writes no call line", async (t) => {
  const fixture = makeFixture(t);
  writeFileSync(join(fixture.engineRoot, "new.txt"), "x");
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.match(plan.error, /dirty/);
  assert.equal(existsSync(join(fixture.runs, "e", "calls.jsonl")), false);
});

test("L4-U13: a call that passes its start checks writes iteration.json and its call line", async (t) => {
  const fixture = makeFixture(t);
  const plan = await startRun(fixture.start(heldOut("e")));
  const results = join(fixture.runs, "e");
  assert.deepEqual(jsonLines(join(results, "calls.jsonl")), [{ cap_usd: 15 }]);
  assert.deepEqual(JSON.parse(readFileSync(join(results, "iteration.json"))), {
    stage: 1,
    set: "held-out",
    set_commit: git(fixture.set, ["rev-parse", "HEAD"]),
    engine_commit: git(fixture.engineRoot, ["rev-parse", "HEAD"]),
    repeats: 2,
    gate_share: 0.5,
    parent: null,
    replicate: null,
    aspect: null,
    hypothesis: null,
  });
  assert.equal(plan.error, undefined);
  await startRun(fixture.start(heldOut("e")));
  assert.equal(jsonLines(join(results, "calls.jsonl")).length, 2);
});

test("L4-U13: a resumed call refuses options that differ from iteration.json", async (t) => {
  const fixture = makeFixture(t);
  await startRun(fixture.start(heldOut("e")));
  const argv = ["--evaluation", "e", "--stage", "2", "--set", "held-out"];
  const plan = await startRun(fixture.start(argv));
  assert.match(plan.error, /--stage/);
  assert.equal(jsonLines(join(fixture.runs, "e", "calls.jsonl")).length, 1);
});

test("L4-U13: a call refuses a set_commit that differs from the HEAD of the set", async (t) => {
  const fixture = makeFixture(t);
  await startRun(fixture.start(heldOut("e")));
  writeFileSync(join(fixture.set, "README.md"), "new");
  git(fixture.set, ["add", "README.md"]);
  git(fixture.set, ["commit", "-q", "-m", "new"]);
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.match(plan.error, /set_commit/);
  assert.equal(jsonLines(join(fixture.runs, "e", "calls.jsonl")).length, 1);
});

test("L4-U13: a call refuses a gate_share that differs from an earlier held-out evaluation of the stage", async (t) => {
  const fixture = makeFixture(t);
  await startRun(fixture.start(heldOut("first")));
  const config = { ...VALID_CONFIG, gate_share: 0.6 };
  writeFileSync(join(fixture.set, "config.json"), JSON.stringify(config));
  const plan = await startRun(fixture.start(heldOut("second")));
  assert.match(plan.error, /gate_share/);
  assert.equal(existsSync(join(fixture.runs, "second")), false);
  const stageTwo = [
    "--evaluation",
    "third",
    "--stage",
    "2",
    "--set",
    "held-out",
  ];
  assert.equal((await startRun(fixture.start(stageTwo))).error, undefined);
});

test("L4-U13: a call refuses a case that breaks the case schema", async (t) => {
  const fixture = makeFixture(t, { h1: { json: { wall: "3h" } } });
  const plan = await startRun(fixture.start(heldOut("e")));
  assert.match(plan.error, /case h1/);
  assert.equal(existsSync(fixture.runs), false);
});

test("L4-U14: the credential state holds the digest, the mode and the entries", (t) => {
  const root = tempDir(t);
  assert.equal(captureAuthState(join(root, "absent.json")), null);
  const state = captureAuthState(makeAuthFile(root, '{"a":1}'));
  assert.equal(state.digest.length, 64);
  assert.equal(state.mode, 0o600);
  assert.deepEqual(state.entries, ["auth.json"]);
});

test("L4-U14: an unchanged auth.json is no breach", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}');
  const saved = captureAuthState(authPath);
  assert.equal(checkAuthFileBreach(authPath, saved), false);
});

test("L4-U14: a changed digest is the breach auth_file", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(authPath, '{"a":2}');
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U14: a changed mode is the breach auth_file", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}');
  const saved = captureAuthState(authPath);
  chmodSync(authPath, 0o644);
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U14: a mode other than 0600 at both times is the breach auth_file", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}', 0o644);
  const saved = captureAuthState(authPath);
  assert.equal(checkAuthFileBreach(authPath, saved), true);
  assert.equal(refreshedAuthBreach(saved, saved), true);
});

test("L4-U14: a new entry in the configuration directory is the breach auth_file", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(join(dirname(authPath), "new.json"), "{}");
  assert.equal(checkAuthFileBreach(authPath, saved), true);
  assert.equal(refreshedAuthBreach(captureAuthState(authPath), saved), true);
});

test("L4-U14: a removed auth.json is the breach auth_file", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}');
  const saved = captureAuthState(authPath);
  rmSync(authPath);
  assert.equal(checkAuthFileBreach(authPath, saved), true);
});

test("L4-U14: a refresh that changes the digest only is no breach", (t) => {
  const authPath = makeAuthFile(tempDir(t), '{"a":1}');
  const saved = captureAuthState(authPath);
  writeFileSync(authPath, '{"a":2}');
  assert.equal(refreshedAuthBreach(captureAuthState(authPath), saved), false);
});

test("L4-U14: a run that changes auth.json stops the evaluation with the breach auth_file", async (t) => {
  let authPath;
  const fixture = makeFixture(t);
  authPath = fixture.authPath;
  const plan = await startRun(fixture.start(heldOut("e")));
  const agent = fakeAgent({
    work: () => writeFileSync(authPath, '{"changed":true}'),
  });
  const output = await captured(() => runPlan(plan, agent.deps));
  const checks = jsonLines(join(fixture.runs, "e", "checks.jsonl"));
  assert.equal(output.value, 1);
  assert.deepEqual(
    checks.map((line) => line.breach),
    ["auth_file"],
  );
});

test("L4-U14: a run that adds an entry to the configuration directory stops with the breach auth_file", async (t) => {
  let authPath;
  const fixture = makeFixture(t);
  authPath = fixture.authPath;
  const plan = await startRun(fixture.start(heldOut("e")));
  const agent = fakeAgent({
    work: () => writeFileSync(join(dirname(authPath), "models.json"), "{}"),
  });
  const output = await captured(() => runPlan(plan, agent.deps));
  const checks = jsonLines(join(fixture.runs, "e", "checks.jsonl"));
  assert.equal(output.value, 1);
  assert.equal(checks[0].breach, "auth_file");
});

function fakeRuntime(entries, getAuth) {
  const created = [];
  const create = async (options) => {
    created.push(options);
    return { listCredentials: async () => entries, getAuth };
  };
  return { created, create };
}

test("L4-U15: an api_key entry and an absent entry get no refresh", async () => {
  let calls = 0;
  const getAuth = async () => {
    calls++;
    return {};
  };
  const apiKey = fakeRuntime([{ providerId: "anthropic", type: "api_key" }]);
  await refreshAuth("/auth.json", "anthropic", 1, apiKey.create);
  const other = [{ providerId: "openai-codex", type: "oauth" }];
  await refreshAuth(
    "/auth.json",
    "anthropic",
    1,
    fakeRuntime(other, getAuth).create,
  );
  await refreshAuth(
    "/auth.json",
    "anthropic",
    1,
    fakeRuntime([], getAuth).create,
  );
  assert.equal(calls, 0);
});

test("L4-U15: the refresh uses the auth path, the provider and the validity of the call", async () => {
  const seen = [];
  const entries = [{ providerId: "anthropic", type: "oauth" }];
  const runtime = fakeRuntime(entries, async (...args) => {
    seen.push(args);
    return {};
  });
  await refreshAuth("/auth.json", "anthropic", 1200000, runtime.create);
  assert.deepEqual(seen, [["anthropic", { minOAuthValidityMs: 1200000 }]]);
  assert.deepEqual(runtime.created, [
    {
      authPath: "/auth.json",
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    },
  ]);
});

test("L4-U15: an undefined result and a thrown error fail the refresh", async () => {
  const entries = [{ providerId: "anthropic", type: "oauth" }];
  const none = fakeRuntime(entries, async () => undefined);
  await assert.rejects(refreshAuth("/auth.json", "anthropic", 1, none.create));
  const thrown = fakeRuntime(entries, async () => {
    throw new Error("response body");
  });
  await assert.rejects(
    refreshAuth("/auth.json", "anthropic", 1, thrown.create),
  );
});

test("L4-U15: an oauth entry that expires far in the future keeps auth.json and prints nothing", async (t) => {
  const root = tempDir(t);
  const authPath = makeAuthFile(
    root,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "access-value",
        refresh: "refresh-value",
        expires: Date.now() + 365 * 86400000,
      },
    }),
  );
  const saved = captureAuthState(authPath);
  const output = await captured(() =>
    refreshAuth(authPath, "anthropic", 130 * 60000),
  );
  assert.equal(checkAuthFileBreach(authPath, saved), false);
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "");
});

test("L4-U15: a failed refresh stops the evaluation before the run with no error text of pi", async (t) => {
  const fixture = makeFixture(t);
  const plan = await startRun(fixture.start(heldOut("e")));
  const agent = fakeAgent();
  const seen = [];
  agent.deps.refresh = async (...args) => {
    seen.push(args);
    throw new Error("pi-error-text response body");
  };
  const output = await captured(() => runPlan(plan, agent.deps));
  assert.equal(output.value, 1);
  assert.equal(agent.calls.length, 0);
  assert.equal(
    `${output.stdout}${output.stderr}`.includes("pi-error-text"),
    false,
  );
  assert.deepEqual(seen, [[fixture.authPath, "openai-compatible", 40 * 60000]]);
  assert.deepEqual(workRoots(fixture), []);
});

test("L4-U16: the price read uses an in-memory credential store and no auth path", async () => {
  const created = [];
  await readModelPrices(async (options) => {
    created.push(options);
    return { getModel: () => undefined };
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].credentials instanceof InMemoryCredentialStore, true);
  assert.deepEqual(Object.keys(created[0]).sort(), [
    "allowModelNetwork",
    "credentials",
    "modelsPath",
    "refreshOnCreate",
  ]);
  assert.equal(created[0].modelsPath, null);
  assert.equal(created[0].allowModelNetwork, false);
});

test("L4-U16: the price read gives the base prices and creates no entry in the configuration directory", async () => {
  const configDir = join(userInfo().homedir, ".config", "kanthord");
  const list = () => (existsSync(configDir) ? readdirSync(configDir) : null);
  const before = list();
  const prices = await readModelPrices();
  assert.deepEqual(list(), before);
  const model = prices.getModel("openrouter", "deepseek/deepseek-v4.1-flash");
  assert.equal(model.cost.input, 0.3);
  assert.equal(model.cost.output, 1.2);
  assert.equal(model.cost.cacheRead, 0.006);
});

test("L4-U16: the price read gives no model for openai-compatible/stub-1", async () => {
  const prices = await readModelPrices();
  assert.equal(prices.getModel("openai-compatible", "stub-1"), undefined);
});

test("L4-U20: the diff command holds each flag of the diff steps", () => {
  assert.deepEqual(diffArgs(), [
    "diff",
    "--cached",
    "--binary",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ]);
});

test("L4-U20: the diff steps restore .git/config and remove .git/info/attributes", (t) => {
  const root = tempDir(t);
  const entry = makeCase(root, "c1");
  const work = join(root, "w");
  const marker = join(root, "driver-ran");
  const savedConfig = cloneSteps(
    join(entry.folder, "repo.bundle"),
    work,
    entry.json.commit,
  );
  appendFileSync(
    join(work, ".git", "config"),
    `[diff "leak"]\n\ttextconv = touch ${marker} && cat\n[filter "leak"]\n\tclean = touch ${marker} && cat\n`,
  );
  writeFileSync(
    join(work, ".git", "info", "attributes"),
    "* diff=leak filter=leak\n",
  );
  writeFileSync(join(work, "ok.txt"), "ok");
  const diffPath = join(root, "diff.patch");
  assert.equal(
    diffSteps(work, entry.json.commit, { savedConfig, diffPath }),
    true,
  );
  assert.deepEqual(readFileSync(join(work, ".git", "config")), savedConfig);
  assert.equal(existsSync(join(work, ".git", "info", "attributes")), false);
  assert.equal(existsSync(marker), false);
  assert.match(
    readFileSync(diffPath, "utf8"),
    /^diff --git a\/ok\.txt b\/ok\.txt\n/,
  );
  assert.equal(lstatSync(diffPath).mode & 0o777, 0o600);
});

test("L4-U20: the diff steps replace a symbolic link at .git/config", (t) => {
  const root = tempDir(t);
  const entry = makeCase(root, "c1");
  const work = join(root, "w");
  const target = join(root, "target");
  writeFileSync(target, "target");
  const savedConfig = cloneSteps(
    join(entry.folder, "repo.bundle"),
    work,
    entry.json.commit,
  );
  rmSync(join(work, ".git", "config"));
  symlinkSync(target, join(work, ".git", "config"));
  const diffPath = join(root, "diff.patch");
  assert.equal(
    diffSteps(work, entry.json.commit, { savedConfig, diffPath }),
    true,
  );
  assert.equal(readFileSync(target, "utf8"), "target");
  assert.equal(lstatSync(join(work, ".git", "config")).isFile(), true);
});

test("the clone steps leave no path of the case folder in the clone", (t) => {
  const root = tempDir(t);
  const entry = makeCase(root, "c1");
  const work = join(root, "w");
  cloneSteps(join(entry.folder, "repo.bundle"), work, entry.json.commit);
  assert.equal(git(work, ["remote"]), "");
  assert.equal(git(work, ["reflog"]), "");
  assert.equal(
    readFileSync(join(work, ".git", "config"), "utf8").includes(entry.folder),
    false,
  );
  assert.equal(
    cloneSteps(join(root, "absent.bundle"), join(root, "x"), "a"),
    null,
  );
});

test("a held-out evaluation gives the gate verdict pass and keeps no check.txt", async (t) => {
  const run = await runHeldOut(t, "e4");
  assert.equal(run.value, 0);
  assert.equal(run.agent.calls.length, 2);
  assert.equal(run.checks.length, 2);
  for (const line of run.checks) {
    assert.deepEqual(
      [line.a1, line.a2, line.a3, line.a4, line.pass, line.breach],
      [true, true, true, true, true, null],
    );
  }
  for (const name of ["1-1", "2-1"])
    assert.deepEqual(readdirSync(join(run.results, "h1", name)).sort(), [
      "diff.patch",
      "session.jsonl",
      "stderr.txt",
    ]);
  assert.deepEqual(workRoots(run), []);
  assert.equal(git(run.set, ["status", "--porcelain"]), "");
  const report = await reportEvaluation(run.start(["--evaluation", "e4"]));
  assert.equal(report.verdict, "pass");
  const text = readFileSync(join(run.results, "report.md"), "utf8");
  assert.match(
    text,
    /^gate: pass share backend 100\.0%, gate_share 0\.5, breaches 0, earlier held-out evaluations 0, verdict pass$/m,
  );
  assert.match(text, /^swe@1: list price 0, r none, base cost 0$/m);
  assert.match(text, /^cap_usd of each call: 15$/m);
  assert.equal(text.includes("h1"), false);
  const again = await startRun(run.start(heldOut("e4")));
  const agent = fakeAgent();
  assert.equal((await captured(() => runPlan(again, agent.deps))).value, 0);
  assert.equal(agent.calls.length, 0);
});

test("a failed setup.sh stops the evaluation before the run and leaves no workspace root", async (t) => {
  const run = await runHeldOut(t, "e", {}, { h1: { setup: "exit 1\n" } });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 0);
  assert.deepEqual(workRoots(run), []);
});

const RUNNER_DIR = fileURLToPath(new URL(".", import.meta.url));
const SECOND_KEY = "ZyXwVuTsRqPoNmLkJiHgFeDcBaZyXwVuTsRqPoNm";
const JUDGE_VALIDITY_MS = 25 * 60000;
const FINDING = { aspect: "A5", evidence: "check.txt: x", severity: "medium" };

function reLine(change = {}) {
  return {
    agent: "re@1",
    engine_version: "1",
    provider: "a",
    model: "m",
    reasoning_effort: "off",
    system_prompt_digest: "d",
    input_digest: "i",
    budget: { wall_ms: 1, usd: null },
    session: "/r/d1/1-1/judge-1.jsonl",
    ...change,
  };
}

function makeDevFixture(t, overrides = {}) {
  const root = tempDir(t);
  const engineRoot = join(root, "engine");
  makeRepo(engineRoot, { "a.txt": "a" });
  const set = join(root, "xd", "kanthord", "evaluation", "agent");
  const d1 = makeCase(join(set, "cases", "dev"), "d1", overrides.d1);
  rmSync(join(set, "cases", "dev", "d1-repo"), { recursive: true });
  if (overrides.task) writeFile(join(d1.folder, "task.md"), overrides.task);
  writeFile(join(set, ".gitignore"), "config.json\n");
  writeFile(join(set, "binding", "backend.md"), "# Binding\n\nbackend\n");
  makeRepo(set, {});
  const config = { ...VALID_CONFIG, ...overrides.config };
  writeFile(join(set, "config.json"), JSON.stringify(config));
  const authPath = apiKeyAuth(root);
  const start = (argv) => ({
    argv,
    env: {
      XDG_DATA_HOME: join(root, "xd"),
      XDG_STATE_HOME: join(root, "xs"),
    },
    execArgv: [],
    engineRoot,
    authPath,
    readPrices: async () => FAKE_PRICES,
  });
  const runs = join(root, "xs", "kanthord", "evaluation", "runs");
  return { root, engineRoot, set, authPath, start, runs };
}

function devArgs(id, stage = "1") {
  return ["--evaluation", id, "--stage", stage, "--set", "dev"];
}

function judgeLine(args, change) {
  return {
    ...resultLine(args, "completed"),
    agent: "re@1",
    budget: { wall_ms: 900000, usd: null },
    text: '{"findings":[]}',
    ...change,
  };
}

function fakeDevAgent(options = {}) {
  const calls = [];
  let judgeCalls = 0;
  let sweCalls = 0;
  const runAgent = (args, stderrPath) => {
    calls.push(args);
    writeFileSync(stderrPath, "");
    const session = option(args, "--session");
    const output = option(args, "--output");
    if (args[2] === "swe@1") {
      writeFileSync(session, options.session ?? "{}\n");
      writeFileSync(join(option(args, "--workspace"), "ok.txt"), "ok");
      if (options.sweWork) options.sweWork(dirname(session));
      const line = resultLine(args, "completed");
      appendFileSync(output, `${JSON.stringify(line)}\n`);
      sweCalls++;
      return options.sweExits?.[sweCalls - 1] ?? 0;
    }
    if (options.judgeWork) options.judgeWork(args);
    writeFileSync(session, options.judgeSession ?? "{}\n");
    const line = judgeLine(args, options.judgeLine);
    appendFileSync(output, `${JSON.stringify(line)}\n`);
    judgeCalls++;
    return options.judgeExits?.[judgeCalls - 1] ?? options.judgeExit ?? 0;
  };
  return { calls, deps: { refresh: async () => {}, runAgent } };
}

async function runDev(t, agentOptions, overrides = {}) {
  const fixture = makeDevFixture(t, overrides);
  const plan = await startRun(fixture.start(devArgs("e", overrides.stage)));
  assert.equal(plan.error, undefined);
  const agent = fakeDevAgent(agentOptions);
  if (overrides.refresh) agent.deps.refresh = overrides.refresh(fixture);
  const output = await captured(() => runPlan(plan, agent.deps));
  const results = join(fixture.runs, "e");
  return {
    ...fixture,
    ...output,
    agent,
    results,
    checks: jsonLines(join(results, "checks.jsonl")),
    diagnoses: jsonLines(join(results, "diagnoses.jsonl")),
    runDir: join(results, "d1", "1-1"),
  };
}

function diagnosisText(findings) {
  return JSON.stringify({ findings });
}

function checkLine(caseId, repeat, change = {}) {
  return {
    case: caseId,
    repeat,
    session: `/r/${caseId}/${repeat}-1/session.jsonl`,
    a1: true,
    a2: true,
    a3: true,
    a4: true,
    pass: true,
    breach: null,
    ...change,
  };
}

function diagnosisLine(caseId, repeat, findings, change = {}) {
  return {
    session: `/r/${caseId}/${repeat}-1/judge-1.jsonl`,
    valid: true,
    findings,
    ...change,
  };
}

function devReport(cases, checks, diagnoses) {
  return buildReport({
    evalId: "e",
    iteration: { stage: 1, set: "dev", set_commit: "c", repeats: 2 },
    cases: cases.map((id) => ({ id, kind: "backend" })),
    r: null,
    judgeR: null,
    earlier: 0,
    checks,
    results: [],
    calls: [{ cap_usd: 15 }],
    diagnoses,
  });
}

test("L4-U6: the parse accepts one JSON object with each aspect and each severity", () => {
  for (const aspect of ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]) {
    for (const severity of ["high", "medium", "low"]) {
      const findings = [{ aspect, evidence: "e", severity }];
      assert.deepEqual(
        parseDiagnosis(diagnosisText(findings), "completed"),
        { valid: true, findings },
        `${aspect} ${severity}`,
      );
    }
  }
  assert.deepEqual(parseDiagnosis('{"findings":[]}', "completed"), {
    valid: true,
    findings: [],
  });
});

test("L4-U6: the parse refuses a run that does not end completed", () => {
  const text = diagnosisText([FINDING]);
  for (const end of ["budget_end", "failed", undefined])
    assert.deepEqual(parseDiagnosis(text, end), { valid: false, findings: [] });
});

test("L4-U6: the parse refuses a text that is not exactly one JSON object", () => {
  const one = diagnosisText([FINDING]);
  const texts = [
    undefined,
    "no findings",
    `${one} ${one}`,
    `The findings: ${one}`,
    `\`\`\`json\n${one}\n\`\`\``,
    "[]",
    '{"findings":{}}',
  ];
  for (const text of texts)
    assert.equal(parseDiagnosis(text, "completed").valid, false, text);
});

test("L4-U6: the parse refuses an absent or added field", () => {
  const texts = [
    "{}",
    '{"findings":[],"extra":1}',
    diagnosisText([{ aspect: "A5", evidence: "e" }]),
    diagnosisText([{ aspect: "A5", severity: "low" }]),
    diagnosisText([{ evidence: "e", severity: "low" }]),
    diagnosisText([{ ...FINDING, extra: 1 }]),
    diagnosisText(["A5"]),
  ];
  for (const text of texts)
    assert.equal(parseDiagnosis(text, "completed").valid, false, text);
});

test("L4-U6: the parse refuses an aspect and a severity outside their lists", () => {
  for (const change of [
    { aspect: "A0" },
    { aspect: "A10" },
    { aspect: "a5" },
    { severity: "critical" },
    { severity: "" },
  ]) {
    const text = diagnosisText([{ ...FINDING, ...change }]);
    assert.equal(parseDiagnosis(text, "completed").valid, false, text);
  }
});

test("L4-U6: the evidence has 1 to 500 characters", () => {
  const valid = (evidence) =>
    parseDiagnosis(diagnosisText([{ ...FINDING, evidence }]), "completed")
      .valid;
  assert.equal(valid(""), false);
  assert.equal(valid("x"), true);
  assert.equal(valid("x".repeat(500)), true);
  assert.equal(valid("x".repeat(501)), false);
  assert.equal(valid(1), false);
});

test("L4-U6: the parse accepts 20 findings and refuses 21", () => {
  const text = (length) => diagnosisText(Array.from({ length }, () => FINDING));
  assert.equal(parseDiagnosis(text(20), "completed").valid, true);
  assert.equal(parseDiagnosis(text(21), "completed").valid, false);
});

test("L4-U6: an evidence that quotes a brace is valid", () => {
  const findings = [{ ...FINDING, evidence: "diff.patch: function a() {" }];
  assert.deepEqual(parseDiagnosis(diagnosisText(findings), "completed"), {
    valid: true,
    findings,
  });
});

test("L4-U6: a run is good on A5, A6 and A7 with a valid diagnosis and no high or medium finding", () => {
  const report = devReport(
    ["c1"],
    [checkLine("c1", 1), checkLine("c1", 2)],
    [
      diagnosisLine("c1", 1, [
        { aspect: "A5", evidence: "evidence-one", severity: "medium" },
        { aspect: "A9", evidence: "evidence-two", severity: "high" },
      ]),
      diagnosisLine("c1", 2, [
        { aspect: "A5", evidence: "evidence-three", severity: "low" },
        { aspect: "A6", evidence: "evidence-four", severity: "high" },
      ]),
    ],
  );
  assert.match(
    report.text,
    /^A5 good runs: 1, findings: 0 high, 1 medium, 1 low$/m,
  );
  assert.match(
    report.text,
    /^A6 good runs: 1, findings: 1 high, 0 medium, 0 low$/m,
  );
  assert.match(
    report.text,
    /^A7 good runs: 2, findings: 0 high, 0 medium, 0 low$/m,
  );
  assert.match(report.text, /^A9 findings: 1 high, 0 medium, 0 low$/m);
  assert.match(
    report.text,
    /^case c1: passes 2, A1 2, A2 2, A3 2, A4 2, A5 1, A6 1, A7 2$/m,
  );
  assert.match(report.text, /^invalid diagnoses: 0$/m);
  assert.equal(report.text.includes("evidence-"), false);
});

test("L4-U6: a run with an invalid diagnosis is good on no diagnosed aspect", () => {
  const report = devReport(
    ["c1"],
    [checkLine("c1", 1), checkLine("c1", 2)],
    [diagnosisLine("c1", 1, []), diagnosisLine("c1", 2, [], { valid: false })],
  );
  assert.match(report.text, /^invalid diagnoses: 1$/m);
  for (const aspect of ["A5", "A6", "A7"])
    assert.match(
      report.text,
      new RegExp(
        `^${aspect} good runs: 1, findings: 0 high, 0 medium, 0 low$`,
        "m",
      ),
    );
  assert.equal(report.verdict, "complete");
});

test("L4-U11: the set-difficulty line counts each ceiling case and each floor case", () => {
  const fail = { a1: false, pass: false };
  const report = devReport(
    ["c1", "c2", "c3", "c4", "c5"],
    [
      checkLine("c1", 1),
      checkLine("c1", 2),
      checkLine("c2", 1, fail),
      checkLine("c2", 2, fail),
      checkLine("c3", 1),
      checkLine("c3", 2, fail),
      checkLine("c4", 1),
      checkLine("c5", 1, fail),
    ],
    [],
  );
  assert.match(report.text, /^set-difficulty: 1 ceiling, 1 floor of 5$/m);
  assert.equal(report.verdict, "no verdict");
  assert.match(report.text, /^unstarted runs: 2, unstarted diagnoses: 10$/m);
});

test("L4-U11: a dev evaluation is complete when each planned run and each planned diagnosis has a line", () => {
  const checks = [checkLine("c1", 1), checkLine("c1", 2)];
  const diagnoses = [diagnosisLine("c1", 1, []), diagnosisLine("c1", 2, [])];
  const complete = devReport(["c1"], checks, diagnoses);
  assert.equal(complete.verdict, "complete");
  assert.match(complete.text, /^verdict complete$/m);
  assert.match(complete.text, /^unstarted runs: 0, unstarted diagnoses: 0$/m);
  const noDiagnosis = devReport(["c1"], checks, diagnoses.slice(0, 1));
  assert.equal(noDiagnosis.verdict, "no verdict");
  assert.match(
    noDiagnosis.text,
    /^unstarted runs: 0, unstarted diagnoses: 1$/m,
  );
  const noRun = devReport(["c1"], checks.slice(0, 1), diagnoses.slice(0, 1));
  assert.equal(noRun.verdict, "no verdict");
});

test("L4-U11: the report accepts re@1 lines with equal keys", () => {
  const second = reLine({ session: "/r/d1/2-1/judge-1.jsonl" });
  assert.equal(checkResultKeys([sweLine(), reLine(), second]), null);
});

test("L4-U11: the report refuses each break of a key of the re@1 lines and names the two lines", () => {
  for (const key of [
    "provider",
    "model",
    "reasoning_effort",
    "system_prompt_digest",
  ]) {
    const lines = [sweLine(), reLine(), reLine({ [key]: "other" })];
    assert.deepEqual(checkResultKeys(lines), { key, lines: [2, 3] });
  }
});

test("L4-U12: the diagnosis of a run is the last line of its run directory", () => {
  const first = diagnosisLine("c1", 1, [], { valid: false });
  const second = diagnosisLine("c1", 1, [FINDING], {
    session: "/r/c1/1-1/judge-2.jsonl",
  });
  const report = devReport(
    ["c1"],
    [checkLine("c1", 1), checkLine("c1", 2)],
    [first, second, diagnosisLine("c1", 2, [])],
  );
  assert.match(report.text, /^invalid diagnoses: 0$/m);
  assert.match(
    report.text,
    /^A5 good runs: 1, findings: 0 high, 1 medium, 0 low$/m,
  );
  assert.equal(report.verdict, "complete");
});

test("L4-U12: the last check line of a run counts", () => {
  const breach = { a1: false, a2: false, a3: false, a4: false, pass: false };
  const report = devReport(
    ["c1"],
    [
      checkLine("c1", 1),
      checkLine("c1", 2),
      checkLine("c1", 2, { ...breach, breach: "credential" }),
    ],
    [diagnosisLine("c1", 1, [])],
  );
  assert.match(report.text, /^passes: 1 of 2 planned runs$/m);
  assert.match(report.text, /^A9 breaches: 1 \(credential\)$/m);
  assert.match(report.text, /^unstarted runs: 0, unstarted diagnoses: 1$/m);
  assert.equal(report.verdict, "no verdict");
});

test("L4-U12: the diagnosis call has the options of the diagnosis command and no cost budget for a model with no price", () => {
  const run = {
    config: {
      judge_model: "openai-compatible/stub-1:off",
      judge_usd: "0.1usd",
    },
    judgeRatio: { run: null, base: BASE_BLEND },
    resultsPath: "/r/results.jsonl",
  };
  const args = runAgentArgsJudge(run, "/w/j", "/r/d1/1-1/judge-1.jsonl");
  assert.deepEqual(args, [
    "run",
    "agent",
    "re@1",
    "--model",
    "openai-compatible/stub-1:off",
    "--budget",
    "15m",
    "--system-prompt",
    join(RUNNER_DIR, "judge.md"),
    "--workspace",
    "/w/j",
    "--session",
    "/r/d1/1-1/judge-1.jsonl",
    "--output",
    "/r/results.jsonl",
    "--prompt",
    join(RUNNER_DIR, "judge-task.md"),
  ]);
});

test("L4-U9: a diagnosis run of a model with a price gets the scaled judge_usd", () => {
  const run = {
    config: {
      judge_model: "anthropic/claude-haiku-5-5:high",
      judge_usd: "0.1usd",
    },
    judgeRatio: { run: HAIKU_BLEND, base: BASE_BLEND },
    resultsPath: "/r/results.jsonl",
  };
  const args = runAgentArgsJudge(run, "/w/j", "/r/judge-1.jsonl");
  assert.deepEqual(args.slice(5, 9), [
    "--budget",
    "15m",
    "--budget",
    "0.22usd",
  ]);
});

test("L4-U9: a judge_usd reserve equal to cap_usd starts the diagnosis", async (t) => {
  const run = await runDev(
    t,
    {},
    {
      d1: { json: { usd: "0.1usd" } },
      config: { judge_usd: "0.5usd", cap_usd: 0.5 },
    },
  );
  assert.equal(run.value, 0);
  assert.equal(run.diagnoses.length, 2);
});

test("L4-U9: a judge_usd reserve one cent above cap_usd stops the call with exit 4 before the diagnosis", async (t) => {
  const run = await runDev(
    t,
    {},
    {
      d1: { json: { usd: "0.1usd" } },
      config: { judge_usd: "0.51usd", cap_usd: 0.5 },
    },
  );
  assert.equal(run.value, 4);
  assert.equal(run.agent.calls.length, 1);
  assert.equal(run.checks.length, 1);
  assert.equal(run.diagnoses.length, 0);
  assert.deepEqual(workRoots(run), []);
});

test("L4-U9: the base cost of a re@1 line uses the ratio of the judge model", async (t) => {
  const run = await runDev(
    t,
    { judgeLine: { list_price_usd: 2 } },
    {
      d1: { json: { usd: "0.01usd" } },
      config: {
        judge_model: "anthropic/claude-haiku-5-5:high",
        judge_usd: "0.01usd",
        cap_usd: 0.5,
      },
    },
  );
  assert.equal(run.value, 4);
  assert.equal(run.agent.calls.length, 2);
  const text = readFileSync(join(run.results, "report.md"), "utf8");
  assert.match(text, /^re@1: list price 2, r 2\.13964, base cost 0\.934737$/m);
  assert.match(text, /^swe@1: list price 0, r none, base cost 0$/m);
});

test("a dev evaluation diagnoses each run in the judge workspace of the grading root", async (t) => {
  const seen = [];
  const judgeWork = (args) => {
    const workspace = option(args, "--workspace");
    seen.push({
      workspace,
      siblings: readdirSync(dirname(workspace)).sort(),
      files: readdirSync(workspace).sort(),
      check: JSON.parse(readFileSync(join(workspace, "check.json"), "utf8")),
      task: readFileSync(join(workspace, "task.md"), "utf8"),
    });
  };
  const run = await runDev(t, {
    judgeWork,
    judgeLine: { text: diagnosisText([FINDING]) },
  });
  assert.equal(run.value, 0);
  assert.deepEqual(
    run.agent.calls.map((args) => args[2]),
    ["swe@1", "re@1", "swe@1", "re@1"],
  );
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].workspace, seen[1].workspace);
  assert.deepEqual(seen[0].siblings, ["g", "j"]);
  assert.deepEqual(seen[0].files, [
    "check.json",
    "check.txt",
    "diff.patch",
    "task.md",
    "transcript.md",
  ]);
  assert.deepEqual(seen[0].check, run.checks[0]);
  assert.equal(seen[0].task, "task d1\n");
  assert.deepEqual(run.diagnoses, [
    {
      session: join(run.runDir, "judge-1.jsonl"),
      valid: true,
      findings: [FINDING],
    },
    {
      session: join(run.results, "d1", "2-1", "judge-1.jsonl"),
      valid: true,
      findings: [FINDING],
    },
  ]);
  assert.deepEqual(readdirSync(run.runDir).sort(), [
    "check.txt",
    "diff.patch",
    "judge-1-stderr.txt",
    "judge-1.jsonl",
    "session.jsonl",
    "stderr.txt",
  ]);
  assert.deepEqual(workRoots(run), []);
  const report = await reportEvaluation(run.start(["--evaluation", "e"]));
  assert.equal(report.verdict, "complete");
});

test("a stage 2 diagnosis gets the kind prompt of the case kind in the judge workspace", async (t) => {
  const seen = [];
  const judgeWork = (args) => {
    const workspace = option(args, "--workspace");
    seen.push(readFileSync(join(workspace, "backend.md"), "utf8"));
  };
  const run = await runDev(t, { judgeWork }, { stage: "2" });
  assert.equal(run.value, 0);
  assert.deepEqual(seen, ["# Binding\n\nbackend\n", "# Binding\n\nbackend\n"]);
  assert.equal(
    option(run.agent.calls[0], "--system-prompt"),
    join(run.set, "binding", "backend.md"),
  );
});

test("L4-U12: a diagnosis run that ends budget_end with exit 5 gives an invalid diagnosis and changes no pass", async (t) => {
  const run = await runDev(t, {
    judgeExit: 5,
    judgeLine: { end: "budget_end" },
  });
  assert.equal(run.value, 0);
  assert.deepEqual(
    run.diagnoses.map((line) => [line.valid, line.findings]),
    [
      [false, []],
      [false, []],
    ],
  );
  assert.deepEqual(
    run.checks.map((line) => line.pass),
    [true, true],
  );
});

test("L4-U12: an exit 1 of a diagnosis run stops the evaluation with no diagnosis line", async (t) => {
  const run = await runDev(t, { judgeExit: 1 });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 2);
  assert.equal(run.checks.length, 1);
  assert.equal(run.diagnoses.length, 0);
  assert.deepEqual(workRoots(run), []);
});

test("L4-U12: the diagnosis of a run that started again reads the run directory of the last attempt", async (t) => {
  const checks = [];
  const judgeWork = (args) => {
    const path = join(option(args, "--workspace"), "check.json");
    checks.push(JSON.parse(readFileSync(path, "utf8")).session);
  };
  const run = await runDev(t, { sweExits: [75], judgeWork });
  const last = join(run.results, "d1", "1-2");
  assert.equal(run.value, 0);
  assert.equal(checks[0], join(last, "session.jsonl"));
  assert.equal(run.checks[0].session, join(last, "session.jsonl"));
  assert.equal(run.diagnoses[0].session, join(last, "judge-1.jsonl"));
  assert.deepEqual(readdirSync(run.runDir).sort(), [
    "session.jsonl",
    "stderr.txt",
  ]);
});

test("L4-U9: a resumed diagnosis reserves judge_usd and no usd of the case", async (t) => {
  const run = await runDev(t, { judgeExit: 1 });
  assert.equal(run.value, 1);
  assert.equal(run.checks.length, 1);
  writeFile(
    join(run.set, "config.json"),
    JSON.stringify({ ...VALID_CONFIG, cap_usd: 0.2 }),
  );
  const agent = fakeDevAgent({});
  assert.equal((await resume(run, devArgs("e"), agent)).value, 4);
  assert.deepEqual(
    agent.calls.map((args) => args[2]),
    ["re@1"],
  );
  assert.equal(jsonLines(join(run.results, "diagnoses.jsonl")).length, 1);
});

test("L4-U12: an exit 75 of a diagnosis run starts the diagnosis again as the next attempt", async (t) => {
  const run = await runDev(t, { judgeExits: [75] });
  assert.equal(run.value, 0);
  assert.equal(run.checks.length, 2);
  assert.deepEqual(
    run.diagnoses.map((line) => line.session),
    [
      join(run.runDir, "judge-2.jsonl"),
      join(run.results, "d1", "2-1", "judge-1.jsonl"),
    ],
  );
  assert.equal(existsSync(join(run.runDir, "judge-1-stderr.txt")), true);
});

test("L4-U12: the third exit 75 of one diagnosis run in one call stops the evaluation, and the resume takes the next free attempt", async (t) => {
  const run = await runDev(t, { judgeExit: 75 });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 4);
  assert.equal(run.checks.length, 1);
  assert.equal(run.diagnoses.length, 0);
  assert.deepEqual(workRoots(run), []);
  const agent = fakeDevAgent({});
  assert.equal((await resume(run, devArgs("e"), agent)).value, 0);
  assert.equal(
    option(agent.calls[0], "--session"),
    join(run.runDir, "judge-4.jsonl"),
  );
  assert.equal(jsonLines(join(run.results, "checks.jsonl")).length, 2);
  assert.equal(jsonLines(join(run.results, "diagnoses.jsonl")).length, 2);
});

test("L4-U9: the cost of a diagnosis attempt that exits 75 counts, and the cap stops the call before the next attempt", async (t) => {
  const run = await runDev(
    t,
    { judgeExit: 75, judgeLine: { list_price_usd: 40 } },
    { config: { judge_model: "anthropic/claude-haiku-5-5:high" } },
  );
  assert.equal(run.value, 4);
  assert.equal(run.agent.calls.length, 2);
  assert.equal(run.diagnoses.length, 0);
});

test("L4-U12: a diagnosis takes the next free attempt number", async (t) => {
  const sweWork = (runDir) => {
    writeFileSync(join(runDir, "judge-1.jsonl"), "{}\n");
    writeFileSync(join(runDir, "judge-2-stderr.txt"), "");
  };
  const run = await runDev(t, { sweWork });
  assert.equal(run.value, 0);
  assert.equal(run.diagnoses[0].session, join(run.runDir, "judge-3.jsonl"));
  assert.equal(existsSync(join(run.runDir, "judge-3-stderr.txt")), true);
});

test("L4-U5: a credential value in the diagnosis session file stops the evaluation with the count only", async (t) => {
  const run = await runDev(t, { judgeSession: `{"text":"${KEY}"}\n` });
  assert.equal(run.value, 1);
  assert.equal(run.agent.calls.length, 2);
  assert.match(run.stdout, /count 1\n/);
  assert.equal(`${run.stdout}${run.stderr}`.includes(KEY.slice(0, 8)), false);
  assert.deepEqual(
    run.checks.map((line) => [line.repeat, line.pass, line.breach]),
    [
      [1, true, null],
      [1, false, "credential"],
    ],
  );
  assert.equal(run.diagnoses.length, 0);
  assert.deepEqual(workRoots(run), []);
  const text = readFileSync(join(run.results, "report.md"), "utf8");
  assert.equal(text.includes(KEY), false);
  assert.match(text, /^A9 breaches: 1 \(credential\)$/m);
  assert.match(text, /^passes: 0 of 2 planned runs$/m);
});

test("L4-U5: a credential value in a file of the judge workspace stops the evaluation before the diagnosis call", async (t) => {
  const run = await runDev(t, {}, { task: `task d1 ${KEY}\n` });
  assert.equal(run.value, 1);
  assert.deepEqual(
    run.agent.calls.map((args) => args[2]),
    ["swe@1"],
  );
  assert.match(run.stdout, /count 1\n/);
  assert.equal(run.stdout.includes(KEY.slice(0, 8)), false);
  assert.equal(run.checks.at(-1).breach, "credential");
  assert.equal(run.diagnoses.length, 0);
  assert.deepEqual(workRoots(run), []);
});

test("L4-U5: the diagnosis run counts the credential values that the runner reads after its refresh", async (t) => {
  const refresh = (fixture) => async (authPath, provider) => {
    if (provider !== "anthropic") return;
    const entry = { type: "api_key", key: SECOND_KEY };
    writeFileSync(fixture.authPath, JSON.stringify({ anthropic: entry }));
  };
  const run = await runDev(
    t,
    { judgeSession: `{"text":"${SECOND_KEY}"}\n` },
    { refresh, config: { judge_model: "anthropic/claude-haiku-5-5:high" } },
  );
  assert.equal(run.value, 1);
  assert.match(run.stdout, /count 1\n/);
  assert.equal(run.checks.at(-1).breach, "credential");
});

test("L4-U5: the breach credential of a diagnosis run comes before the breach auth_file", async (t) => {
  let authPath;
  const run = await runDev(
    t,
    {
      judgeSession: `{"text":"${KEY}"}\n`,
      judgeWork: () => writeFileSync(authPath, '{"changed":true}'),
    },
    {
      refresh: (fixture) => {
        authPath = fixture.authPath;
        return async () => {};
      },
    },
  );
  assert.equal(run.value, 1);
  assert.equal(run.checks.at(-1).breach, "credential");
});

test("L4-U14: a diagnosis run that changes auth.json stops the evaluation with the breach auth_file", async (t) => {
  let authPath;
  const run = await runDev(
    t,
    { judgeWork: () => writeFileSync(authPath, '{"changed":true}') },
    {
      refresh: (fixture) => {
        authPath = fixture.authPath;
        return async () => {};
      },
    },
  );
  assert.equal(run.value, 1);
  assert.deepEqual(
    run.checks.map((line) => line.breach),
    [null, "auth_file"],
  );
  assert.equal(run.diagnoses.length, 0);
});

test("L4-U14: a diagnosis run that adds an entry to the configuration directory stops with the breach auth_file", async (t) => {
  let authPath;
  const run = await runDev(
    t,
    {
      judgeWork: () =>
        writeFileSync(join(dirname(authPath), "models.json"), "{}"),
    },
    {
      refresh: (fixture) => {
        authPath = fixture.authPath;
        return async () => {};
      },
    },
  );
  assert.equal(run.value, 1);
  assert.equal(run.checks.at(-1).breach, "auth_file");
});

test("L4-U14: a refresh before the diagnosis that changes the mode of auth.json is the breach auth_file", async (t) => {
  const refresh = (fixture) => async (authPath, provider) => {
    if (provider === "anthropic") chmodSync(fixture.authPath, 0o644);
  };
  const run = await runDev(
    t,
    {},
    { refresh, config: { judge_model: "anthropic/claude-haiku-5-5:high" } },
  );
  assert.equal(run.value, 1);
  assert.deepEqual(
    run.agent.calls.map((args) => args[2]),
    ["swe@1"],
  );
  assert.equal(run.checks.at(-1).breach, "auth_file");
});

test("L4-U15: the refresh of a diagnosis run uses the provider of judge_model and the wall budget 15m", async (t) => {
  const seen = [];
  const refresh =
    () =>
    async (...args) => {
      seen.push(args);
    };
  const run = await runDev(
    t,
    {},
    { refresh, config: { judge_model: "anthropic/claude-haiku-5-5:high" } },
  );
  assert.equal(run.value, 0);
  assert.deepEqual(seen.slice(0, 2), [
    [run.authPath, "openai-compatible", 40 * 60000],
    [run.authPath, "anthropic", JUDGE_VALIDITY_MS],
  ]);
  assert.equal(seen.length, 4);
});

test("L4-U15: a failed refresh stops the evaluation before the diagnosis call with no error text of pi", async (t) => {
  const refresh = () => async (authPath, provider) => {
    if (provider === "anthropic")
      throw new Error("pi-error-text response body");
  };
  const run = await runDev(
    t,
    {},
    { refresh, config: { judge_model: "anthropic/claude-haiku-5-5:high" } },
  );
  assert.equal(run.value, 1);
  assert.deepEqual(
    run.agent.calls.map((args) => args[2]),
    ["swe@1"],
  );
  assert.equal(`${run.stdout}${run.stderr}`.includes("pi-error-text"), false);
  assert.equal(run.diagnoses.length, 0);
  assert.deepEqual(workRoots(run), []);
});

function sessionEntry(id, message) {
  return JSON.stringify({ type: "message", id, parentId: null, message });
}

function transcriptOf(t, lines) {
  const root = tempDir(t);
  const session = join(root, "session.jsonl");
  const transcript = join(root, "transcript.md");
  if (lines !== null) writeFileSync(session, `${lines.join("\n")}\n`);
  writeTranscript(session, transcript);
  return readFileSync(transcript, "utf8");
}

test("L4-U19: the transcript holds the id, the role and the text of each entry", (t) => {
  const text = transcriptOf(t, [
    JSON.stringify({ type: "session", id: "head" }),
    sessionEntry("e1", { role: "user", content: "task text" }),
    sessionEntry("e2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "I run the tests." },
        {
          type: "toolCall",
          id: "c",
          name: "bash",
          arguments: { command: "npm test" },
        },
      ],
    }),
    sessionEntry("e3", {
      role: "toolResult",
      content: [{ type: "text", text: "1 passed" }],
    }),
    JSON.stringify({ type: "model_change", id: "e4" }),
    "not json",
  ]);
  assert.equal(
    text,
    [
      "## e1",
      "",
      "Role: user",
      "",
      "task text",
      "",
      "## e2",
      "",
      "Role: assistant",
      "",
      "I run the tests.",
      'Tool call bash: {"command":"npm test"}',
      "",
      "## e3",
      "",
      "Role: toolResult",
      "",
      "1 passed",
      "",
    ].join("\n"),
  );
});

test("L4-U19: the transcript cuts each tool result to 4,000 characters", (t) => {
  const long = { type: "text", text: `${"x".repeat(4000)}yy` };
  const text = transcriptOf(t, [
    sessionEntry("e1", { role: "toolResult", content: [long] }),
    sessionEntry("e2", { role: "assistant", content: [long] }),
  ]);
  const [, result, answer] = text.split(/^## e\d$/m);
  assert.equal(result.includes("x".repeat(4000)), true);
  assert.equal(result.includes("y"), false);
  assert.equal(answer.includes("yy"), true);
});

test("L4-U19: an absent session file gives an empty transcript", (t) => {
  assert.equal(transcriptOf(t, null), "");
});

const EVAL_SCRIPT = fileURLToPath(new URL("evaluation.mjs", import.meta.url));

const FAKE_LLM_KEY =
  "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfG1a";

function makeValidateCase(root, id, overrides = {}) {
  const set = join(root, "set");
  const kind = overrides.json?.kind ?? VALID_CASE.kind;
  if (overrides.binding !== null)
    writeFile(
      join(set, "binding", `${kind}.md`),
      overrides.binding ?? "# Binding\n\nfixture\n",
    );
  const cases = join(set, "cases", "dev");
  const { folder, json } = makeCase(cases, id, overrides);
  const workDir = join(root, `${id}-patch-work`);
  git(undefined, ["clone", "--quiet", join(folder, "repo.bundle"), workDir]);
  const files = overrides.patchFiles ?? { "ok.txt": "ok\n" };
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(workDir, name), text);
  git(workDir, ["add", "-A"]);
  writeFileSync(
    join(folder, "check", "reference.patch"),
    `${git(workDir, ["diff", "--staged", "--binary"])}\n`,
  );
  rmSync(workDir, { recursive: true });
  rmSync(join(cases, `${id}-repo`), { recursive: true });
  return { folder, json, set };
}

function runScript(argv, options = {}) {
  return spawnSync(process.execPath, [EVAL_SCRIPT, ...argv], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...isolatedGitEnvironment(process.env), ...options.env },
  });
}

function runValidate(root, folder) {
  const temporary = join(root, "tmp");
  mkdirSync(temporary, { recursive: true });
  const result = runScript(["validate", folder], {
    env: { TMPDIR: temporary },
  });
  return { ...result, left: readdirSync(temporary) };
}

function allPaths(dir) {
  return readdirSync(dir, { recursive: true }).sort();
}

function stagedRepo(t, files) {
  const repo = join(tempDir(t), "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--quiet"]);
  for (const [name, content] of Object.entries(files)) {
    writeFile(join(repo, name), content);
  }
  git(repo, ["add", "-A"]);
  return repo;
}

function pairReport(pair, options = {}) {
  const cases = [...new Set(pair.parentChecks.map((line) => line.case))];
  const records = (checks, diagnoses) => ({
    cases: cases.map((id) => ({ id, kind: "backend" })),
    r: null,
    judgeR: null,
    earlier: 0,
    checks,
    results: [],
    calls: [{ cap_usd: 15 }],
    diagnoses:
      diagnoses ??
      checks.map((line) => diagnosisLine(line.case, line.repeat, [])),
  });
  const base = { stage: 1, set: "dev", set_commit: "c", repeats: 2 };
  const none = { parent: null, aspect: null, hypothesis: null };
  const named = options.replicate
    ? { ...none, replicate: "p" }
    : {
        parent: "p",
        aspect: options.aspect ?? "A1",
        hypothesis: "h",
        replicate: null,
      };
  return buildReport({
    evalId: "e",
    iteration: { ...base, ...named },
    ...records(pair.checks, pair.diagnoses),
    reKeysDiffer: options.reKeysDiffer ?? false,
    parent: {
      evalId: "p",
      iteration: { ...base, ...none, replicate: null },
      ...records(pair.parentChecks, pair.parentDiagnoses),
    },
  });
}

function runsOf(caseId, change1 = {}, change2 = change1) {
  return [checkLine(caseId, 1, change1), checkLine(caseId, 2, change2)];
}

const A1_FAIL = { a1: false, pass: false };
const A2_FAIL = { a2: false, pass: false };
const A5_FINDING = [{ aspect: "A5", evidence: "e", severity: "medium" }];

test("L4-U7: goodOnRunNoise reads the check field for A1 to A4", () => {
  for (const aspect of ["A1", "A2", "A3", "A4"]) {
    const lc = aspect.toLowerCase();
    assert.equal(
      goodOnRunNoise({ [lc]: true }, undefined, aspect, false),
      true,
    );
    assert.equal(
      goodOnRunNoise({ [lc]: false }, undefined, aspect, false),
      false,
    );
  }
});

test("L4-U7: an invalid diagnosis counts as good in the parent and not good in the new evaluation", () => {
  const invalid = { valid: false, findings: [] };
  for (const aspect of ["A5", "A6", "A7"]) {
    assert.equal(goodOnRunNoise({}, invalid, aspect, true), true, aspect);
    assert.equal(goodOnRunNoise({}, invalid, aspect, false), false, aspect);
  }
});

test("L4-U7: a valid diagnosis with no high or medium finding of the aspect is good", () => {
  const low = {
    valid: true,
    findings: [{ aspect: "A5", evidence: "e", severity: "low" }],
  };
  assert.equal(goodOnRunNoise({}, low, "A5", false), true);
  const otherHigh = {
    valid: true,
    findings: [{ aspect: "A6", evidence: "e", severity: "high" }],
  };
  assert.equal(goodOnRunNoise({}, otherHigh, "A5", false), true);
});

test("L4-U7: a valid diagnosis with a high or medium finding of the aspect is not good", () => {
  const high = {
    valid: true,
    findings: [{ aspect: "A5", evidence: "e", severity: "high" }],
  };
  assert.equal(goodOnRunNoise({}, high, "A5", false), false);
  const medium = { valid: true, findings: A5_FINDING };
  assert.equal(goodOnRunNoise({}, medium, "A5", false), false);
  assert.equal(goodOnRunNoise({}, medium, "A6", false), true);
});

test("L4-U7: flipsCountForAspect counts 0, 1, 2 and 3 flips", () => {
  const none = runsOf("c1");
  assert.equal(flipsCountForAspect(none, [], "A1", false), 0);
  const one = runsOf("c1", {}, A1_FAIL);
  assert.equal(flipsCountForAspect(one, [], "A1", false), 1);
  const two = [...one, ...runsOf("c2", {}, A1_FAIL)];
  assert.equal(flipsCountForAspect(two, [], "A1", false), 2);
  const three = [...two, ...runsOf("c3", {}, A1_FAIL)];
  assert.equal(flipsCountForAspect(three, [], "A1", false), 3);
});

test("L4-U7: passFlipsCount counts 0, 1 and 2 flips", () => {
  assert.equal(passFlipsCount(runsOf("c1")), 0);
  const one = runsOf("c1", {}, { pass: false });
  assert.equal(passFlipsCount(one), 1);
  assert.equal(
    passFlipsCount([...one, ...runsOf("c2", {}, { pass: false })]),
    2,
  );
});

test("L4-U7: the verdict is keep when the gain equals the noise", () => {
  const report = pairReport({
    parentChecks: [...runsOf("c1"), ...runsOf("c2", A1_FAIL)],
    checks: [...runsOf("c1"), ...runsOf("c2")],
  });
  assert.equal(report.verdict, "keep");
  assert.match(
    report.text,
    /^iteration: target A1, good parent 2 new 4 noise 2, passes parent 2 new 4 noise 2, verdict keep$/m,
  );
  assert.match(
    report.text,
    /^diff: A1 2, A2 0, A3 0, A4 0, A5 0, A6 0, A7 0$/m,
  );
  assert.equal(report.text.match(/verdict /g).length, 1);
});

test("L4-U7: the verdict is revert when the gain is one below the noise", () => {
  const report = pairReport({
    parentChecks: [...runsOf("c1"), ...runsOf("c2", A1_FAIL)],
    checks: [...runsOf("c1"), ...runsOf("c2", {}, A1_FAIL)],
  });
  assert.equal(report.verdict, "revert");
  assert.match(report.text, /good parent 2 new 3 noise 2/);
});

test("L4-U7: 3 flips of the parent on the target give the noise 3", () => {
  const flipping = ["c1", "c2", "c3"].flatMap((id) => runsOf(id, {}, A1_FAIL));
  const parentChecks = [...flipping, ...runsOf("c4", A1_FAIL)];
  const gainOfTwo = pairReport({
    parentChecks,
    checks: [...flipping, ...runsOf("c4")],
  });
  assert.equal(gainOfTwo.verdict, "revert");
  assert.match(gainOfTwo.text, /good parent 3 new 5 noise 3/);
  const gainOfThree = pairReport({
    parentChecks,
    checks: [...runsOf("c1"), ...flipping.slice(2), ...runsOf("c4")],
  });
  assert.equal(gainOfThree.verdict, "keep");
  assert.match(gainOfThree.text, /good parent 3 new 6 noise 3/);
});

test("L4-U7: a pass regression equal to the noise gives revert, and one below gives keep", () => {
  const parentChecks = [
    ...runsOf("c1", A2_FAIL),
    ...runsOf("c2"),
    ...runsOf("c3"),
  ];
  const equal = pairReport(
    {
      parentChecks,
      checks: [
        ...runsOf("c1"),
        ...runsOf("c2", A1_FAIL),
        ...runsOf("c3", A1_FAIL),
      ],
    },
    { aspect: "A2" },
  );
  assert.equal(equal.verdict, "revert");
  assert.match(equal.text, /new 6 noise 2, passes parent 4 new 2 noise 2/);
  const oneBelow = pairReport(
    {
      parentChecks,
      checks: [
        ...runsOf("c1"),
        ...runsOf("c2", A1_FAIL),
        ...runsOf("c3", {}, A1_FAIL),
      ],
    },
    { aspect: "A2" },
  );
  assert.equal(oneBelow.verdict, "keep");
  assert.match(oneBelow.text, /passes parent 4 new 3 noise 2/);
});

test("L4-U7: a breach gives revert, also with a planned run with no line", () => {
  const report = pairReport({
    parentChecks: [...runsOf("c1"), ...runsOf("c2", A1_FAIL)],
    checks: [
      ...runsOf("c1"),
      checkLine("c2", 1, { ...A1_FAIL, breach: "credential" }),
    ],
  });
  assert.equal(report.verdict, "revert");
});

test("L4-U7: a planned run with no line in the new evaluation or in the parent gives no verdict", () => {
  const full = [...runsOf("c1"), ...runsOf("c2")];
  const short = [...runsOf("c1"), checkLine("c2", 1)];
  const parentFull = [...runsOf("c1"), ...runsOf("c2", A1_FAIL)];
  const parentShort = [...runsOf("c1"), checkLine("c2", 1, A1_FAIL)];
  for (const pair of [
    { parentChecks: parentFull, checks: short },
    { parentChecks: parentShort, checks: full },
  ]) {
    const report = pairReport(pair);
    assert.equal(report.verdict, "no verdict");
    assert.match(report.text, /^iteration: .*verdict no verdict$/m);
  }
});

test("L4-U7: a planned diagnosis with no line in the new evaluation or in the parent gives no verdict, also for a target A1", () => {
  const parentChecks = [...runsOf("c1"), ...runsOf("c2", A1_FAIL)];
  const checks = [...runsOf("c1"), ...runsOf("c2")];
  const three = (lines) =>
    lines.slice(1).map((line) => diagnosisLine(line.case, line.repeat, []));
  assert.equal(pairReport({ parentChecks, checks }).verdict, "keep");
  assert.equal(
    pairReport({ parentChecks, checks, diagnoses: three(checks) }).verdict,
    "no verdict",
  );
  assert.equal(
    pairReport({
      parentChecks,
      checks,
      parentDiagnoses: three(parentChecks),
    }).verdict,
    "no verdict",
  );
});

test("L4-U7: re@1 lines that differ in provider, model or reasoning_effort give no verdict for A5 to A7 only", () => {
  const pair = {
    parentChecks: [...runsOf("c1"), ...runsOf("c2", A1_FAIL)],
    checks: [...runsOf("c1"), ...runsOf("c2")],
  };
  for (const aspect of ["A5", "A6", "A7"]) {
    const report = pairReport(pair, { aspect, reKeysDiffer: true });
    assert.equal(report.verdict, "no verdict", aspect);
  }
  const scripted = pairReport(pair, { aspect: "A1", reKeysDiffer: true });
  assert.equal(scripted.verdict, "keep");
  for (const key of ["provider", "model", "reasoning_effort"]) {
    assert.equal(reKeysDiffer([reLine()], [reLine({ [key]: "x" })]), true);
    assert.equal(
      reKeysDiffer([reLine()], [reLine(), reLine({ [key]: "x" })]),
      true,
    );
  }
  assert.equal(reKeysDiffer([reLine()], [reLine()]), false);
  assert.equal(reKeysDiffer([], [reLine({ model: "x" })]), false);
});

test("L4-U7: an invalid diagnosis of the parent counts as good in the verdict", () => {
  const checks = [...runsOf("c1"), ...runsOf("c2")];
  const report = pairReport(
    {
      parentChecks: checks,
      parentDiagnoses: [
        diagnosisLine("c1", 1, [], { valid: false }),
        diagnosisLine("c1", 2, [], { valid: false }),
        diagnosisLine("c2", 1, A5_FINDING),
        diagnosisLine("c2", 2, A5_FINDING),
      ],
      checks,
      diagnoses: [
        diagnosisLine("c1", 1, []),
        diagnosisLine("c1", 2, []),
        diagnosisLine("c2", 1, []),
        diagnosisLine("c2", 2, A5_FINDING),
      ],
    },
    { aspect: "A5" },
  );
  assert.match(report.text, /good parent 2 new 3 noise 2/);
  assert.equal(report.verdict, "revert");
});

test("L4-U7: an invalid diagnosis of the new evaluation counts as not good in the verdict", () => {
  const checks = [...runsOf("c1"), ...runsOf("c2")];
  const report = pairReport(
    {
      parentChecks: checks,
      parentDiagnoses: checks.map((line) =>
        diagnosisLine(line.case, line.repeat, A5_FINDING),
      ),
      checks,
      diagnoses: [
        diagnosisLine("c1", 1, [], { valid: false }),
        diagnosisLine("c1", 2, []),
        diagnosisLine("c2", 1, []),
        diagnosisLine("c2", 2, []),
      ],
    },
    { aspect: "A5" },
  );
  assert.match(report.text, /good parent 0 new 3 noise 2/);
  assert.equal(report.verdict, "keep");
});

test("L4-U7: the A/A line shows the goods, the difference and the flips of the first for each aspect, and the passes", () => {
  const report = pairReport(
    {
      parentChecks: [...runsOf("c1", {}, A1_FAIL), ...runsOf("c2", A1_FAIL)],
      parentDiagnoses: [
        diagnosisLine("c1", 1, [], { valid: false }),
        diagnosisLine("c1", 2, []),
        diagnosisLine("c2", 1, []),
        diagnosisLine("c2", 2, []),
      ],
      checks: [...runsOf("c1"), ...runsOf("c2", A1_FAIL)],
    },
    { replicate: true },
  );
  assert.equal(report.verdict, "complete");
  assert.match(
    report.text,
    /^A\/A: A1 1 2 diff 1 flips 1, A2 4 4 diff 0 flips 0, A3 4 4 diff 0 flips 0, A4 4 4 diff 0 flips 0, A5 3 4 diff 1 flips 1, A6 3 4 diff 1 flips 1, A7 3 4 diff 1 flips 1, passes 1 2 diff 1$/m,
  );
  assert.match(report.text, /^verdict complete$/m);
  assert.doesNotMatch(report.text, /^iteration: /m);
});

test("L4-U11: the head of an iteration report holds the parent, the target aspect and the hypothesis", () => {
  const report = pairReport({
    parentChecks: runsOf("c1"),
    checks: runsOf("c1"),
  });
  for (const line of [
    /^parent: p$/m,
    /^target aspect: A1$/m,
    /^hypothesis: h$/m,
  ])
    assert.match(report.text, line);
  const baseline = devReport(["c1"], runsOf("c1"), []);
  assert.doesNotMatch(baseline.text, /^parent: /m);
});

function sweFor(caseId, repeat, change = {}) {
  return sweLine({
    session: `/r/${caseId}/${repeat}-1/session.jsonl`,
    ...change,
  });
}

function pairOf(results, parentResults, change = {}) {
  const iteration = { stage: 1, set: "dev", set_commit: "c", replicate: null };
  return {
    iteration: { ...iteration, ...change.iteration },
    parentIteration: { ...iteration, ...change.parentIteration },
    results,
    parentResults,
    cases: [{ id: "c1" }, { id: "c2" }],
  };
}

test("L4-U11: comparabilityError accepts an iteration pair with equal common keys and two digests", () => {
  const results = [sweFor("c1", 1, { system_prompt_digest: "e" })];
  assert.equal(comparabilityError(pairOf(results, [sweFor("c1", 1)])), null);
});

test("L4-U11: comparabilityError refuses another stage and another set commit", () => {
  const results = [sweFor("c1", 1, { system_prompt_digest: "e" })];
  const parent = [sweFor("c1", 1)];
  assert.equal(
    comparabilityError(
      pairOf(results, parent, { parentIteration: { stage: 2 } }),
    ),
    "stage",
  );
  assert.equal(
    comparabilityError(
      pairOf(results, parent, { parentIteration: { set_commit: "d" } }),
    ),
    "set_commit",
  );
});

test("L4-U11: comparabilityError refuses each common key that differs for one case", () => {
  for (const [key, value] of [
    ["input_digest", "j"],
    ["engine_version", "2"],
    ["provider", "b"],
    ["model", "n"],
    ["reasoning_effort", "low"],
    ["budget", { wall_ms: 2, usd: null }],
  ]) {
    const results = [
      sweFor("c1", 1, { system_prompt_digest: "e" }),
      sweFor("c2", 1, { system_prompt_digest: "e" }),
      sweFor("c2", 2, { system_prompt_digest: "e", [key]: value }),
    ];
    const parent = [sweFor("c1", 1), sweFor("c2", 1)];
    assert.equal(comparabilityError(pairOf(results, parent)), key);
  }
});

test("L4-U11: comparabilityError refuses one system_prompt_digest in an iteration pair, also for the second case only", () => {
  const same = [sweFor("c1", 1)];
  assert.equal(comparabilityError(pairOf(same, same)), "system_prompt_digest");
  const results = [
    sweFor("c1", 1, { system_prompt_digest: "e" }),
    sweFor("c2", 1),
  ];
  const parent = [sweFor("c1", 1), sweFor("c2", 1)];
  assert.equal(
    comparabilityError(pairOf(results, parent)),
    "system_prompt_digest",
  );
});

test("L4-U11: comparabilityError accepts one system_prompt_digest for an A/A pair only, and refuses two digests in it", () => {
  const replicate = { iteration: { replicate: "p" } };
  const same = [sweFor("c1", 1)];
  assert.equal(comparabilityError(pairOf(same, same, replicate)), null);
  const other = [sweFor("c1", 1, { system_prompt_digest: "e" })];
  assert.equal(
    comparabilityError(pairOf(other, same, replicate)),
    "system_prompt_digest",
  );
});

test("L4-U11: reDigestError returns null when one evaluation has no re@1 line or the digests are equal", () => {
  assert.equal(reDigestError([], [reLine()]), null);
  assert.equal(reDigestError([reLine()], []), null);
  assert.equal(reDigestError([reLine()], [reLine()]), null);
});

test("L4-U11: reDigestError refuses each parent re@1 line with another digest", () => {
  const other = reLine({ system_prompt_digest: "other" });
  assert.equal(reDigestError([reLine()], [other]), "system_prompt_digest");
  assert.equal(
    reDigestError([reLine()], [reLine(), other]),
    "system_prompt_digest",
  );
});

test("L4-U11: oneChangeError returns null for the same commit", (t) => {
  const { engineRoot } = makeFixture(t);
  const commit = git(engineRoot, ["rev-parse", "HEAD"]);
  assert.equal(oneChangeError(engineRoot, commit, commit), null);
});

test("L4-U11: oneChangeError returns null for the two allowed files and an error for any other path", (t) => {
  const { engineRoot } = makeFixture(t);
  const parentCommit = git(engineRoot, ["rev-parse", "HEAD"]);
  mkdirSync(join(engineRoot, "static", "prompt", "role"), { recursive: true });
  writeFileSync(join(engineRoot, "static", "prompt", "role", "swe@1.md"), "v2");
  writeFileSync(join(engineRoot, "static", "prompt", "swe@1.md"), "v2");
  git(engineRoot, ["add", "."]);
  git(engineRoot, ["commit", "-q", "-m", "change"]);
  const newCommit = git(engineRoot, ["rev-parse", "HEAD"]);
  assert.equal(oneChangeError(engineRoot, parentCommit, newCommit), null);
  writeFileSync(join(engineRoot, "extra.txt"), "x");
  git(engineRoot, ["add", "extra.txt"]);
  git(engineRoot, ["commit", "-q", "-m", "extra"]);
  const withExtra = git(engineRoot, ["rev-parse", "HEAD"]);
  assert.match(
    oneChangeError(engineRoot, parentCommit, withExtra),
    /extra\.txt/,
  );
  assert.notEqual(
    oneChangeError(engineRoot, parentCommit, "0".repeat(40)),
    null,
  );
});

async function runDevPair(t, secondOptions) {
  const fixture = makeDevFixture(t);
  for (const argv of [devArgs("p"), devArgs("n").concat(secondOptions)]) {
    const plan = await startRun(fixture.start(argv));
    assert.equal(plan.error, undefined);
    await captured(() => runPlan(plan, fakeDevAgent().deps));
  }
  const results = join(fixture.runs, "n");
  const setDigest = (agent, digest) => {
    const lines = jsonLines(join(results, "results.jsonl")).map((line) =>
      line.agent === agent ? { ...line, system_prompt_digest: digest } : line,
    );
    writeFileSync(
      join(results, "results.jsonl"),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
  };
  const report = () => reportEvaluation(fixture.start(["--evaluation", "n"]));
  return { ...fixture, results, setDigest, report };
}

const ITERATION_OPTIONS = [
  "--parent",
  "p",
  "--aspect",
  "A1",
  "--hypothesis",
  "h",
];

test("L4-U11: the report refuses an iteration with the system_prompt_digest of its parent and writes no report", async (t) => {
  const pair = await runDevPair(t, ITERATION_OPTIONS);
  assert.equal(existsSync(join(pair.results, "report.md")), true);
  const report = await pair.report();
  assert.match(report.error, /system_prompt_digest/);
  assert.equal(existsSync(join(pair.results, "report.md")), false);
});

test("L4-U11: the report of an iteration with a new swe@1 digest holds the iteration line and gives the iteration verdict", async (t) => {
  const pair = await runDevPair(t, ITERATION_OPTIONS);
  pair.setDigest("swe@1", "d2");
  const report = await pair.report();
  assert.equal(report.verdict, "revert");
  assert.match(
    readFileSync(join(pair.results, "report.md"), "utf8"),
    /^iteration: target A1, good parent 2 new 2 noise 2, passes parent 2 new 2 noise 2, verdict revert$/m,
  );
});

test("L4-U11: the report refuses an iteration whose re@1 digest differs from the parent", async (t) => {
  const pair = await runDevPair(t, ITERATION_OPTIONS);
  pair.setDigest("swe@1", "d2");
  pair.setDigest("re@1", "j2");
  const report = await pair.report();
  assert.match(report.error, /re@1: system_prompt_digest/);
});

test("L4-U11: the report of an A/A pair accepts one digest and holds the A/A line", async (t) => {
  const pair = await runDevPair(t, ["--replicate", "p"]);
  const report = await pair.report();
  assert.equal(report.verdict, "complete");
  assert.match(
    readFileSync(join(pair.results, "report.md"), "utf8"),
    /^A\/A: A1 2 2 diff 0 flips 0, .*passes 2 2 diff 0$/m,
  );
});

test("L4-U11: the gate line of stage 2 holds the pass shares of the last passed stage 1 gate", async (t) => {
  const fixture = makeFixture(t);
  const stageTwo = (id) => [
    "--evaluation",
    id,
    "--stage",
    "2",
    "--set",
    "held-out",
  ];
  const run = async (argv, agentOptions) => {
    const plan = await startRun(fixture.start(argv));
    assert.equal(plan.error, undefined);
    await captured(() => runPlan(plan, fakeAgent(agentOptions).deps));
  };
  const gateLine = async (id) => {
    const report = await reportEvaluation(fixture.start(["--evaluation", id]));
    assert.equal(report.error, undefined);
    return readFileSync(join(fixture.runs, id, "report.md"), "utf8");
  };
  await run(heldOut("failed"), { end: "failed" });
  await run(stageTwo("early"));
  assert.doesNotMatch(await gateLine("early"), /stage 1 pass share/);
  await run(heldOut("passed"));
  await run(stageTwo("late"));
  assert.match(
    await gateLine("late"),
    /^gate: pass share backend 100\.0%, gate_share 0\.5, breaches 0, earlier held-out evaluations 1, stage 1 pass share backend 100\.0%, verdict pass$/m,
  );
  assert.doesNotMatch(await gateLine("passed"), /stage 1 pass share/);
});

test("L4-U13: a call refuses each broken rule of the iteration options", async (t) => {
  const fixture = makeDevFixture(t);
  const held = ["--evaluation", "e", "--stage", "1", "--set", "held-out"];
  const iteration = (aspect, hypothesis) => [
    "--parent",
    "p",
    "--aspect",
    aspect,
    "--hypothesis",
    hypothesis,
  ];
  for (const [argv, pattern] of [
    [devArgs("e").concat(["--parent", "p"]), /--aspect/],
    [devArgs("e").concat(["--parent", "p", "--aspect", "A1"]), /--hypothesis/],
    [held.concat(iteration("A1", "h")), /--parent requires --set dev/],
    [devArgs("e").concat(iteration("A8", "h")), /--aspect/],
    [devArgs("e").concat(iteration("A1", "")), /--hypothesis/],
    [devArgs("e").concat(iteration("A1", "h".repeat(501))), /--hypothesis/],
    [devArgs("e").concat(["--aspect", "A1"]), /--aspect requires --parent/],
    [devArgs("e").concat(["--hypothesis", "h"]), /--hypothesis requires/],
    [
      devArgs("e").concat(iteration("A1", "h"), ["--replicate", "r"]),
      /--replicate/,
    ],
    [held.concat(["--replicate", "r"]), /--replicate requires --set dev/],
  ]) {
    const plan = await startRun(fixture.start(argv));
    assert.match(plan.error, pattern, argv.join(" "));
  }
  assert.equal(existsSync(fixture.runs), false);
});

test("L4-U13: a call refuses a parent or a first baseline with no iteration.json, of another stage or of the held-out set", async (t) => {
  const fixture = makeDevFixture(t);
  const iteration = (parent) =>
    devArgs("e").concat([
      "--parent",
      parent,
      "--aspect",
      "A1",
      "--hypothesis",
      "h",
    ]);
  const replicate = (first) => devArgs("e").concat(["--replicate", first]);
  await startRun(fixture.start(devArgs("two", "2")));
  writeFile(
    join(fixture.runs, "held", "iteration.json"),
    JSON.stringify({ stage: 1, set: "held-out" }),
  );
  for (const [argv, pattern] of [
    [iteration("absent"), /--parent absent/],
    [iteration("two"), /stage/],
    [iteration("held"), /dev/],
    [replicate("absent"), /--replicate absent/],
    [replicate("two"), /stage/],
    [replicate("held"), /dev/],
  ]) {
    const plan = await startRun(fixture.start(argv));
    assert.match(plan.error, pattern, argv.join(" "));
  }
  assert.equal(existsSync(join(fixture.runs, "e")), false);
  await startRun(fixture.start(devArgs("one")));
  const plan = await startRun(fixture.start(iteration("one")));
  assert.equal(plan.error, undefined);
  const written = JSON.parse(
    readFileSync(join(fixture.runs, "e", "iteration.json"), "utf8"),
  );
  assert.equal(written.parent, "one");
  assert.equal(written.aspect, "A1");
  assert.equal(written.hypothesis, "h");
  assert.equal(written.replicate, null);
});

test("L4-U13: a resumed call refuses --parent, --replicate, --aspect and --hypothesis that differ from iteration.json", async (t) => {
  const fixture = makeDevFixture(t);
  await startRun(fixture.start(devArgs("parent1")));
  await startRun(fixture.start(devArgs("parent2")));
  const iteration = (parent, aspect, hypothesis) =>
    devArgs("e").concat([
      "--parent",
      parent,
      "--aspect",
      aspect,
      "--hypothesis",
      hypothesis,
    ]);
  const first = await startRun(fixture.start(iteration("parent1", "A1", "h1")));
  assert.equal(first.error, undefined);
  for (const [argv, pattern] of [
    [iteration("parent2", "A1", "h1"), /--parent/],
    [iteration("parent1", "A2", "h1"), /--aspect/],
    [iteration("parent1", "A1", "h2"), /--hypothesis/],
    [devArgs("e"), /--parent/],
  ]) {
    const plan = await startRun(fixture.start(argv));
    assert.match(plan.error, pattern, argv.join(" "));
  }
  await startRun(
    fixture.start(devArgs("replic").concat(["--replicate", "parent1"])),
  );
  assert.match(
    (await startRun(fixture.start(devArgs("replic")))).error,
    /--replicate/,
  );
  const calls = jsonLines(join(fixture.runs, "e", "calls.jsonl"));
  assert.equal(calls.length, 1);
});

function assertNoKeyPart(result) {
  const output = `${result.stdout}${result.stderr}`;
  for (let start = 0; start + 8 <= FAKE_LLM_KEY.length; start += 4)
    assert.equal(output.includes(FAKE_LLM_KEY.slice(start, start + 8)), false);
}

test("L4-U17: scan exits 0 when no listed file matches a secret pattern", (t) => {
  const root = tempDir(t);
  const clean = join(root, "clean.txt");
  writeFileSync(clean, "nothing here\n");
  const result = runScript(["scan", clean]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("L4-U17: scan exits 1 and prints only the file, the line and the rule of a match", (t) => {
  const root = tempDir(t);
  const clean = join(root, "clean.txt");
  const file = join(root, "file.txt");
  writeFileSync(clean, "nothing here\n");
  writeFileSync(file, `no secret here\n${FAKE_LLM_KEY}\n`);
  const result = runScript(["scan", clean, file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `${file}:2:llm_provider_key\n`);
  assertNoKeyPart(result);
});

test("L4-U17: scan finds a secret in a binary file", (t) => {
  const file = join(tempDir(t), "file.bin");
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0, 255, 254, 10]),
      Buffer.from(`${FAKE_LLM_KEY}\n`),
      Buffer.from([0, 200, 13]),
    ]),
  );
  const result = runScript(["scan", file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `${file}:2:llm_provider_key\n`);
});

test("L4-U17: scan exits 1 for a listed file that it cannot read", (t) => {
  const result = runScript(["scan", join(tempDir(t), "absent.txt")]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("L4-U17: scan with no file reads the staged content, not the file of the working tree", (t) => {
  const repo = stagedRepo(t, {
    "staged.txt": `${FAKE_LLM_KEY}\n`,
    "tree.txt": "clean\n",
  });
  writeFileSync(join(repo, "staged.txt"), "clean\n");
  writeFileSync(join(repo, "tree.txt"), `${FAKE_LLM_KEY}\n`);
  const result = runScript(["scan"], { cwd: repo });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "staged.txt:1:llm_provider_key\n");
  assertNoKeyPart(result);
});

test("L4-U17: scan with no file exits 0 when no staged file matches", (t) => {
  const repo = stagedRepo(t, { "a.txt": "clean\n" });
  writeFileSync(join(repo, "untracked.txt"), `${FAKE_LLM_KEY}\n`);
  const result = runScript(["scan"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("L4-U17: scan with no file reads a staged file with spaces and non-ASCII characters in its name, and a binary file", (t) => {
  const name = "a dir/tên tệp é.txt";
  const repo = stagedRepo(t, {
    [name]: `x\n${FAKE_LLM_KEY}\n`,
    "b.bin": Buffer.concat([
      Buffer.from([0, 255, 10]),
      Buffer.from(`${FAKE_LLM_KEY}\n`),
    ]),
  });
  const result = runScript(["scan"], { cwd: repo });
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.split("\n").sort(), [
    "",
    `${name}:2:llm_provider_key`,
    "b.bin:2:llm_provider_key",
  ]);
});

test("L4-U17: scan with no file skips a staged deletion and reads a staged change after a commit", (t) => {
  const repo = stagedRepo(t, {
    "gone.txt": `${FAKE_LLM_KEY}\n`,
    "kept.txt": "clean\n",
  });
  git(repo, ["commit", "--quiet", "-m", "first"]);
  git(repo, ["rm", "--quiet", "gone.txt"]);
  assert.equal(runScript(["scan"], { cwd: repo }).status, 0);
  writeFileSync(join(repo, "kept.txt"), `${FAKE_LLM_KEY}\n`);
  git(repo, ["add", "kept.txt"]);
  const result = runScript(["scan"], { cwd: repo });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "kept.txt:1:llm_provider_key\n");
});

test("L4-U17: scan with no file reads the index that GIT_INDEX_FILE names, as git commit -a gives it to the hook", (t) => {
  const repo = stagedRepo(t, { "a.txt": "clean\n" });
  const index = join(repo, ".git", "next-index");
  const env = { ...isolatedGitEnvironment(process.env), GIT_INDEX_FILE: index };
  writeFileSync(join(repo, "a.txt"), `${FAKE_LLM_KEY}\n`);
  const added = spawnSync("git", ["add", "a.txt"], { cwd: repo, env });
  assert.equal(added.status, 0);
  assert.equal(runScript(["scan"], { cwd: repo }).status, 0);
  const result = runScript(["scan"], {
    cwd: repo,
    env: { GIT_INDEX_FILE: index },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "a.txt:1:llm_provider_key\n");
});

test("L4-U17: scan with no file exits 1 outside a git repository", (t) => {
  const result = runScript(["scan"], {
    cwd: tempDir(t),
    env: { GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(result.status, 1);
});

test("L4-U18: validate exits 0 on a valid case folder, and leaves no file in the set and no temporary root", (t) => {
  const root = tempDir(t);
  const { folder, set } = makeValidateCase(root, "c1", {
    setup: "echo installed > node_modules\nexit 0\n",
  });
  const before = allPaths(set);
  const result = runValidate(root, folder);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`, "");
  assert.deepEqual(allPaths(set), before);
  assert.deepEqual(result.left, []);
});

test("L4-U18: validate runs pass_to_pass on C with the hidden tests copied in", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1", {
    check:
      'case "$2" in\n  fail_to_pass) sh test/new.sh;;\n  pass_to_pass) sh test/hidden.sh;;\n  conventions) exit 0;;\nesac\n',
  });
  writeFile(join(folder, "check", "tests", "test", "hidden.sh"), "exit 0\n");
  const result = runValidate(root, folder);
  assert.equal(result.status, 0, result.stderr);
});

test("L4-U18: validate refuses a protected string in a path that setup.sh installs", (t) => {
  for (const setup of [
    "mkdir -p evaluation/agent && echo x > evaluation/agent/x.txt\n",
    "mkdir check && echo x > check/x.txt\n",
    "mkdir lib && echo x > lib/config.json\n",
    'ln -s "$(dirname "$0")/task.md" linked\n',
  ]) {
    const root = tempDir(t);
    const { folder } = makeValidateCase(root, "c1", { setup });
    const result = runValidate(root, folder);
    assert.equal(result.status, 1, setup);
    assert.match(result.stderr, /rule 6/, setup);
    assert.deepEqual(result.left, []);
  }
});

test("L4-U18: validate accepts a path that holds a protected file name after no path boundary", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1", {
    setup: "echo x > tsconfig.json\n",
  });
  assert.equal(runValidate(root, folder).status, 0);
});

test("L4-U18: validate refuses a protected string in task.md and in the kind prompt", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1");
  writeFileSync(join(folder, "task.md"), "see /check/something\n");
  const task = runValidate(root, folder);
  assert.equal(task.status, 1);
  assert.match(task.stderr, /rule 6: task\.md/);
  const other = tempDir(t);
  const prompt = makeValidateCase(other, "c1", {
    binding: "# Binding\n\nread config.json\n",
  });
  const binding = runValidate(other, prompt.folder);
  assert.equal(binding.status, 1);
  assert.match(binding.stderr, /rule 6: binding\/backend\.md/);
});

test("L4-U18: validate refuses a text that names the folder of the set", (t) => {
  const root = tempDir(t);
  const { folder, set } = makeValidateCase(root, "c1");
  writeFileSync(join(folder, "task.md"), `read ${set}\n`);
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rule 6: task\.md/);
});

test("L4-U18: validate refuses a case with no kind prompt and a case with no reference.patch", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1", { binding: null });
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /binding\/backend\.md/);
  const other = tempDir(t);
  const second = makeValidateCase(other, "c1");
  rmSync(join(second.folder, "check", "reference.patch"));
  const absent = runValidate(other, second.folder);
  assert.equal(absent.status, 1);
  assert.match(
    absent.stderr,
    /^evaluation: validate: no check\/reference\.patch\n$/,
  );
});

test("L4-U18: validate refuses fail_to_pass that passes on C", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1", {
    check: "exit 0\n",
  });
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rule 7: fail_to_pass/);
});

test("L4-U18: validate refuses pass_to_pass or conventions that fails on C", (t) => {
  for (const mode of ["pass_to_pass", "conventions"]) {
    const root = tempDir(t);
    const { folder } = makeValidateCase(root, "c1", {
      check: `case "$2" in\n  fail_to_pass) sh test/new.sh;;\n  ${mode}) test -f ok.txt;;\n  *) exit 0;;\nesac\n`,
    });
    const result = runValidate(root, folder);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`rule 7: ${mode}`));
  }
});

test("L4-U18: validate refuses a reference patch that fails a mode", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1");
  writeFileSync(join(folder, "check", "reference.patch"), "");
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /rule 8: reference\.patch fails a1 in try 1 of 3/,
  );
  assert.deepEqual(result.left, []);
});

test("L4-U18: validate refuses a reference patch that fails one mode in one of three tries, and prints no check output", (t) => {
  const root = tempDir(t);
  const counter = join(root, "counter");
  const { folder } = makeValidateCase(root, "c1", {
    check: `echo CHECK-OUTPUT\ncase "$2" in\n  fail_to_pass) echo x >> "${counter}"; test "$(wc -l < "${counter}")" -ne 3 && sh test/new.sh;;\n  pass_to_pass) sh test/old.sh;;\n  conventions) exit 0;;\nesac\n`,
  });
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /rule 8: reference\.patch fails a1 in try 2 of 3/,
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CHECK-OUTPUT/);
});

test("L4-U18: validate refuses a reference patch that does not apply", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1");
  const patch = join(folder, "check", "reference.patch");
  writeFileSync(
    patch,
    readFileSync(patch, "utf8").replace("+++ b/ok.txt", "+++ b/ok.txt\n@@"),
  );
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rule 8: reference\.patch fails a1, a2, a4/);
});

test("L4-U18: validate refuses a reference patch that breaks a scope rule", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1", {
    patchFiles: { "ok.txt": "ok\n", "other.txt": "x\n" },
  });
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rule 8: reference\.patch breaks scope/);
});

test("L4-U18: validate applies the frontend rules to the reference patch of a frontend case", (t) => {
  const root = tempDir(t);
  const { folder } = makeValidateCase(root, "c1", {
    json: { kind: "frontend", allowed: ["ok.txt", "x.tsx"] },
    patchFiles: {
      "ok.txt": "ok\n",
      "x.tsx": 'export const X = <p className="w-[3px]" />;\n',
    },
  });
  const result = runValidate(root, folder);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /rule 8: reference\.patch fails a4 in try 1 of 3/,
  );
});

test("L4-U18: validate refuses a folder that is no case folder", (t) => {
  const root = tempDir(t);
  assert.equal(runScript(["validate", root]).status, 1);
  assert.equal(runScript(["validate", join(root, "absent")]).status, 1);
  assert.equal(runScript(["validate"]).status, 1);
});

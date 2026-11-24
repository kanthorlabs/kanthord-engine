import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { llmStub } from "../src/apps/cli/e2e-llm-stub-test-support.ts";
import { refreshAuthWith } from "./play-run-agent.mjs";

const ENGINE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAY_SCRIPT = join(ENGINE_ROOT, "scripts", "play-run-agent.mjs");
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");
const STUB_PROVIDER = "openai-compatible";
const STUB_MODEL_ID = "stub-1";
const TEST_K = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn";
const TEST_TIMEOUT_MS = 120000;
const SUCCESS = 0;
const FAILURE = 1;
const MODE_MASK = 0o777;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SAMPLE_PROMPT_MARKER = "sum.mjs";
const TEXT_PROMPT = "count to three";
const REFRESH_PROVIDER = "anthropic";
const REFRESH_MIN_MS = 1500000;
const DAY_MS = 86400000;
const UNPRICED_BUDGET = "1usd";

function dateTag() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function refreshFixture(t, entries) {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const X = join(root, "x");
  const H = join(root, "h");
  const authDir = join(root, "cfg");
  const piDir = join(root, "pi");
  for (const dir of [X, H, authDir, piDir]) mkdirSync(dir);
  writeFileSync(join(piDir, "models.json"), "{");
  const authPath = join(authDir, "auth.json");
  if (entries !== undefined) {
    writeFileSync(authPath, JSON.stringify(entries));
    chmodSync(authPath, FILE_MODE);
  }
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: H,
    TMPDIR: root,
    XDG_STATE_HOME: X,
    PI_CODING_AGENT_DIR: piDir,
  };
  return { root, X, H, authDir, piDir, authPath, env };
}

function refreshOnly(fixture, extraEnv) {
  return spawnSync(
    process.execPath,
    [
      PLAY_SCRIPT,
      "--",
      "--auth",
      fixture.authPath,
      "--no-build",
      "--refresh-only",
    ],
    {
      encoding: "utf8",
      env: { ...fixture.env, ...extraEnv },
      timeout: 20000,
    },
  );
}

function spawnScript(args, env) {
  const child = spawn(process.execPath, [PLAY_SCRIPT, ...args], {
    cwd: ENGINE_ROOT,
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

function makeFixture(root) {
  const H = join(root, "h");
  const X = join(root, "x");
  const T = join(root, "tmp");
  const authDir = join(root, "cfg");
  mkdirSync(H);
  mkdirSync(X);
  mkdirSync(T);
  mkdirSync(authDir);
  return { H, X, T, authDir };
}

function makeAuth(authDir, stubBaseUrl) {
  const authPath = join(authDir, "auth.json");
  const authEntry = {
    [STUB_PROVIDER]: {
      type: "api_key",
      key: TEST_K,
      env: {
        OPENAI_COMPATIBLE_BASE_URL: stubBaseUrl,
        OPENAI_COMPATIBLE_MODELS: JSON.stringify([{ id: STUB_MODEL_ID }]),
      },
    },
  };
  writeFileSync(authPath, JSON.stringify(authEntry));
  chmodSync(authPath, FILE_MODE);
  return authPath;
}

test(
  "L2-AC16: the play setup gives a workspace, a placeholder prompt and a run that works",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    assert.ok(existsSync(DIST_MAIN), "dist/main.js absent; run pnpm run build");

    const root = mkdtempSync(join(tmpdir(), "kanthord play'$test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const { H, X, T, authDir } = makeFixture(root);
    const stub = await llmStub(
      t,
      [
        { kind: "text", text: "ok" },
        { kind: "text", text: "ok" },
      ],
      root,
    );
    const authPath = makeAuth(authDir, stub.baseUrl);

    const baseArgs = [
      "--",
      "--model",
      `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`,
      "--auth",
      authPath,
      "--no-refresh",
      "--no-build",
    ];
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: H,
      TMPDIR: T,
      XDG_STATE_HOME: X,
    };

    const run1 = spawnScript(baseArgs, env);
    const [status1] = await once(run1.child, "close");
    const stdout1 = run1.getStdout();
    const stderr1 = run1.getStderr();

    assert.equal(
      status1,
      SUCCESS,
      `first run failed\nstderr:\n${stderr1}\nstdout:\n${stdout1}`,
    );
    assert.ok(!stdout1.includes(TEST_K), "first run stdout holds TEST_K");
    assert.ok(!stderr1.includes(TEST_K), "first run stderr holds TEST_K");

    const playDir = stdout1
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim();
    assert.ok(
      playDir !== undefined && playDir.startsWith(join(X, "kanthord", "play")),
      `play dir not found in stdout:\n${stdout1}`,
    );

    const playDirStat = statSync(playDir);
    assert.equal(
      playDirStat.mode & MODE_MASK,
      DIR_MODE,
      `play directory mode ${(playDirStat.mode & MODE_MASK).toString(8)}`,
    );

    const workspaceDir = join(playDir, "workspace");
    assert.ok(existsSync(workspaceDir), "workspace/ absent after first run");

    const logResult = spawnSync(
      "git",
      ["-C", workspaceDir, "log", "--oneline"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(
      logResult.stdout.trim().split("\n").filter(Boolean).length,
      1,
      "workspace has wrong commit count after first run",
    );

    const promptPath = join(playDir, "prompt.md");
    const promptText = readFileSync(promptPath, "utf8");
    assert.ok(
      promptText.includes(SAMPLE_PROMPT_MARKER),
      `prompt.md does not hold sample text:\n${promptText}`,
    );

    const run2 = spawnScript([...baseArgs, TEXT_PROMPT], env);
    const [status2] = await once(run2.child, "close");
    const stdout2 = run2.getStdout();
    const stderr2 = run2.getStderr();

    assert.equal(
      status2,
      SUCCESS,
      `second run failed\nstderr:\n${stderr2}\nstdout:\n${stdout2}`,
    );
    assert.ok(!stdout2.includes(TEST_K), "second run stdout holds TEST_K");
    assert.ok(!stderr2.includes(TEST_K), "second run stderr holds TEST_K");

    const playDir2 = stdout2
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim();
    assert.equal(
      playDir2,
      playDir,
      "second run used a different play directory",
    );

    const workspaceCommits = spawnSync(
      "git",
      ["-C", workspaceDir, "log", "--oneline"],
      { encoding: "utf8" },
    )
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(
      workspaceCommits.length,
      1,
      `workspace has ${workspaceCommits.length} commits after second run; workspace was recloned`,
    );

    const sessionsDir = join(playDir, "sessions");
    assert.ok(existsSync(sessionsDir), "sessions/ absent");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(
      sessionFiles.length,
      2,
      `sessions/ has ${sessionFiles.length} files after two runs`,
    );
    for (const sf of sessionFiles) {
      const sfStat = statSync(join(sessionsDir, sf));
      assert.equal(
        sfStat.mode & MODE_MASK,
        FILE_MODE,
        `session file ${sf} mode ${(sfStat.mode & MODE_MASK).toString(8)}`,
      );
    }

    const resultPath = join(playDir, "result.jsonl");
    assert.ok(existsSync(resultPath), "result.jsonl absent");
    const resultLines = readFileSync(resultPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const lastResult = JSON.parse(resultLines[resultLines.length - 1]);
    assert.equal(lastResult.end, "completed");

    const allUserMessages = stub.requests.flatMap((r) => {
      const input = Array.isArray(r.body?.input) ? r.body.input : [];
      return input.filter((item) => item.role === "user");
    });
    const getText = (msg) =>
      Array.isArray(msg?.content)
        ? msg.content.map((p) => p.text ?? "").join("")
        : String(msg?.content ?? "");
    assert.ok(
      allUserMessages.length >= 2,
      `expected at least 2 user messages, got ${allUserMessages.length}`,
    );
    assert.ok(
      getText(allUserMessages[0]).includes(promptText.trim()),
      "first request does not hold prompt.md text",
    );
    assert.ok(
      getText(allUserMessages[allUserMessages.length - 1]).includes(
        TEXT_PROMPT,
      ),
      "last request does not hold text prompt",
    );

    const run3 = spawnScript(
      [...baseArgs, "--budget", UNPRICED_BUDGET, TEXT_PROMPT],
      env,
    );
    const [status3] = await once(run3.child, "close");
    assert.notEqual(status3, SUCCESS, "a refused run exits 0");
    assert.ok(
      !run3.getStdout().includes("end:"),
      `regression: a refused run prints the result of an earlier run:\n${run3.getStdout()}`,
    );
  },
);

test("play setup: a play directory that is a symbolic link is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  const target = join(root, "real");
  mkdirSync(X);
  mkdirSync(target, { mode: 0o700 });

  const playBase = join(X, "kanthord", "play");
  mkdirSync(playBase, { recursive: true });

  symlinkSync(target, join(playBase, dateTag()));

  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({}));
  chmodSync(authPath, FILE_MODE);

  const result = spawnSync(
    process.execPath,
    [PLAY_SCRIPT, "--", "--auth", authPath, "--no-refresh", "--no-build"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
      },
      timeout: 10000,
    },
  );

  assert.equal(result.status, FAILURE, "expected exit 1 for symlink play dir");
  assert.deepEqual(readdirSync(target), []);
});

test("play setup: a play parent directory that is a symbolic link is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-parent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  const target = join(root, "real");
  mkdirSync(join(X, "kanthord"), { recursive: true });
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(X, "kanthord", "play"));

  const result = spawnSync(
    process.execPath,
    [PLAY_SCRIPT, "--", "--no-refresh", "--no-build", "--refresh-only"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
      },
      timeout: 10000,
    },
  );

  assert.equal(result.status, FAILURE);
  assert.equal(existsSync(join(target, dateTag(), "workspace")), false);
});

test("play setup: a play directory with wrong mode is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  mkdirSync(X);

  const playBase = join(X, "kanthord", "play");
  mkdirSync(playBase, { recursive: true });

  const badDir = join(playBase, dateTag());
  mkdirSync(badDir, { mode: 0o755 });

  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({}));
  chmodSync(authPath, FILE_MODE);

  const result = spawnSync(
    process.execPath,
    [PLAY_SCRIPT, "--", "--auth", authPath, "--no-refresh", "--no-build"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
      },
      timeout: 10000,
    },
  );

  assert.equal(
    result.status,
    FAILURE,
    "expected exit 1 for wrong mode play dir",
  );
  assert.deepEqual(readdirSync(badDir), []);
});

test("play setup: the play directory name uses the local YYYYMMDD date", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-date-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  mkdirSync(X);

  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({}));
  chmodSync(authPath, FILE_MODE);

  const result = spawnSync(
    process.execPath,
    [PLAY_SCRIPT, "--", "--auth", authPath, "--no-refresh", "--no-build"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
      },
      timeout: 10000,
    },
  );

  const playDir =
    result.stdout
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  const dateSegment = playDir.split("/").pop() ?? "";

  assert.ok(
    /^\d{8}$/.test(dateSegment),
    `play directory name is not YYYYMMDD: ${dateSegment}`,
  );

  const expected = dateTag();
  assert.equal(
    dateSegment,
    expected,
    `play directory date ${dateSegment} does not match today ${expected}`,
  );
});

test("play setup: --no-refresh with --refresh-only skips the refresh and exits 0", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-norefresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  mkdirSync(X);

  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({}));
  chmodSync(authPath, FILE_MODE);

  const result = spawnSync(
    process.execPath,
    [
      PLAY_SCRIPT,
      "--",
      "--auth",
      authPath,
      "--no-refresh",
      "--no-build",
      "--refresh-only",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
      },
      timeout: 10000,
    },
  );

  assert.equal(
    result.status,
    SUCCESS,
    `--no-refresh --refresh-only failed\nstderr: ${result.stderr}`,
  );
});

test("play setup: without --no-refresh, --refresh-only skips the refresh of an absent entry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-refresh-fail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  mkdirSync(X);

  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({}));
  chmodSync(authPath, FILE_MODE);

  const result = spawnSync(
    process.execPath,
    [
      PLAY_SCRIPT,
      "--",
      "--auth",
      authPath,
      "--no-build",
      "--refresh-only",
      "--model",
      "openai-compatible/stub-1:off",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
      },
      timeout: 10000,
    },
  );

  assert.equal(result.status, SUCCESS, result.stderr);
  assert.equal(readFileSync(authPath, "utf8"), JSON.stringify({}));
});

test("play setup: --no-build skips the build step", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  mkdirSync(X);

  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({}));
  chmodSync(authPath, FILE_MODE);

  const markerDir = join(root, "marker");
  mkdirSync(markerDir);
  const fakePnpm = join(markerDir, "pnpm");
  writeFileSync(fakePnpm, '#!/bin/sh\ntouch "$BUILD_MARKER_FILE"\n');
  chmodSync(fakePnpm, 0o755);

  const markerFile = join(root, "build-called");

  spawnSync(
    process.execPath,
    [PLAY_SCRIPT, "--", "--auth", authPath, "--no-refresh", "--no-build"],
    {
      encoding: "utf8",
      env: {
        PATH: `${markerDir}:${process.env.PATH ?? ""}`,
        HOME: root,
        TMPDIR: root,
        XDG_STATE_HOME: X,
        BUILD_MARKER_FILE: markerFile,
      },
      timeout: 10000,
    },
  );

  assert.ok(!existsSync(markerFile), "--no-build still called pnpm build");
});

test("play setup: the refresh of an api_key entry changes no file and reads no pi directory", (t) => {
  const fixture = refreshFixture(t, {
    [REFRESH_PROVIDER]: { type: "api_key", key: TEST_K },
  });
  const before = digest(fixture.authPath);

  const result = refreshOnly(fixture, {});

  assert.equal(result.status, SUCCESS, result.stderr);
  assert.equal(digest(fixture.authPath), before);
  assert.equal(statSync(fixture.authPath).mode & MODE_MASK, FILE_MODE);
  assert.deepEqual(readdirSync(fixture.authDir), ["auth.json"]);
  assert.deepEqual(readdirSync(fixture.piDir), ["models.json"]);
  assert.deepEqual(readdirSync(fixture.H), []);
  assert.ok(!result.stdout.includes(TEST_K));
  assert.ok(!result.stderr.includes(TEST_K));
});

test("play setup: the refresh step runs no command of an api_key entry and resolves no reference", (t) => {
  const fixture = refreshFixture(t, undefined);
  const marker = join(fixture.root, "marker");
  for (const key of [`!touch '${marker}'`, "$FIXTURE_VAR"]) {
    writeFileSync(
      fixture.authPath,
      JSON.stringify({ [REFRESH_PROVIDER]: { type: "api_key", key } }),
    );
    chmodSync(fixture.authPath, FILE_MODE);
    const before = digest(fixture.authPath);

    const result = refreshOnly(fixture, { FIXTURE_VAR: TEST_K });

    assert.equal(result.status, SUCCESS, result.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(digest(fixture.authPath), before);
    assert.deepEqual(readdirSync(fixture.authDir), ["auth.json"]);
  }
});

test("play setup: an oauth entry that outlives the budget gets no refresh request and no write", async (t) => {
  const fixture = refreshFixture(t, {
    [REFRESH_PROVIDER]: {
      type: "oauth",
      access: TEST_K,
      refresh: TEST_K,
      expires: Date.now() + DAY_MS,
    },
  });
  const before = digest(fixture.authPath);

  await refreshAuthWith(fixture.authPath, REFRESH_PROVIDER, REFRESH_MIN_MS);

  assert.equal(digest(fixture.authPath), before);
  assert.deepEqual(readdirSync(fixture.authDir), ["auth.json"]);
});

test("play setup: an absent --auth file is refused before the refresh and is not created", (t) => {
  const fixture = refreshFixture(t, undefined);

  const result = refreshOnly(fixture, {});

  assert.equal(result.status, FAILURE);
  assert.deepEqual(readdirSync(fixture.authDir), []);
});

test("play setup: an --auth file with a group or other bit is refused before the refresh", (t) => {
  const fixture = refreshFixture(t, {
    [REFRESH_PROVIDER]: { type: "api_key", key: TEST_K },
  });
  chmodSync(fixture.authPath, 0o644);

  const result = refreshOnly(fixture, {});

  assert.equal(result.status, FAILURE);
  assert.deepEqual(readdirSync(fixture.authDir), ["auth.json"]);
});

test("play setup: a Node proxy setting is refused before the refresh", (t) => {
  const fixture = refreshFixture(t, {
    [REFRESH_PROVIDER]: { type: "api_key", key: TEST_K },
  });

  assert.equal(
    refreshOnly(fixture, { NODE_USE_ENV_PROXY: "1" }).status,
    FAILURE,
  );
  assert.equal(
    refreshOnly(fixture, { NODE_OPTIONS: "--use-env-proxy" }).status,
    FAILURE,
  );
});

test("play setup: a prompt in more than one argument is refused", (t) => {
  const fixture = refreshFixture(t, undefined);

  const result = spawnSync(
    process.execPath,
    [PLAY_SCRIPT, "--", "--no-refresh", "--no-build", "count", "to", "three"],
    { encoding: "utf8", env: fixture.env, timeout: 10000 },
  );

  assert.equal(result.status, FAILURE);
  assert.deepEqual(readdirSync(fixture.X), []);
});

test("play setup: refreshAuthWith throws when getAuth returns undefined", async () => {
  const fakeCreate = async () => ({
    listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }],
    getAuth: async () => undefined,
  });
  await assert.rejects(() =>
    refreshAuthWith("/auth.json", "anthropic", 100000, fakeCreate),
  );
});

test("play setup: refreshAuthWith propagates a thrown error", async () => {
  const fakeCreate = async () => {
    throw new Error("network unreachable");
  };
  await assert.rejects(() =>
    refreshAuthWith("/auth.json", "anthropic", 100000, fakeCreate),
  );
});

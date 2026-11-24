import assert from "node:assert/strict";
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
  },
);

test("L2-AC16: a play directory that is a symbolic link is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  const target = join(root, "real");
  mkdirSync(X);
  mkdirSync(target, { mode: 0o700 });

  const playBase = join(X, "kanthord", "play");
  mkdirSync(playBase, { recursive: true });

  const d = new Date();
  const dateTag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  symlinkSync(target, join(playBase, dateTag));

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
  assert.ok(
    result.stderr.includes("symbolic link"),
    `stderr does not mention symbolic link:\n${result.stderr}`,
  );
});

test("L2-AC16: a play directory with wrong mode is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanthord play-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const X = join(root, "x");
  mkdirSync(X);

  const playBase = join(X, "kanthord", "play");
  mkdirSync(playBase, { recursive: true });

  const d = new Date();
  const dateTag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const badDir = join(playBase, dateTag);
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
  assert.ok(
    result.stderr.includes("mode"),
    `stderr does not mention mode:\n${result.stderr}`,
  );
});

test("L2-AC16: the play directory name uses the local YYYYMMDD date", (t) => {
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

  const d = new Date();
  const expected = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(
    dateSegment,
    expected,
    `play directory date ${dateSegment} does not match today ${expected}`,
  );
});

test("L2-AC16: --no-refresh with --refresh-only skips the refresh and exits 0", (t) => {
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

test("L2-AC16: without --no-refresh, --refresh-only exits 1 when the entry is absent", (t) => {
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

  assert.equal(
    result.status,
    FAILURE,
    `expected exit 1 when refresh entry is absent`,
  );
});

test("L2-AC16: --no-build skips the build step", (t) => {
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

test("L2-AC16: refreshAuthWith calls getAuth with the given auth path and provider", async () => {
  let capturedAuthPath;
  let capturedProvider;
  let capturedMinMs;

  const fakeCreate = async ({ authPath }) => {
    capturedAuthPath = authPath;
    return {
      getAuth: async (provider, { minOAuthValidityMs }) => {
        capturedProvider = provider;
        capturedMinMs = minOAuthValidityMs;
        return { type: "api_key" };
      },
    };
  };

  const authPath = join(tmpdir(), "unit-auth.json");
  await refreshAuthWith(authPath, "test-provider", 100000, fakeCreate);

  assert.equal(capturedAuthPath, authPath);
  assert.equal(capturedProvider, "test-provider");
  assert.equal(capturedMinMs, 100000);
});

test("L2-AC16: refreshAuthWith throws when getAuth returns undefined", async () => {
  const fakeCreate = async () => ({
    getAuth: async () => undefined,
  });
  await assert.rejects(() =>
    refreshAuthWith("/auth.json", "anthropic", 100000, fakeCreate),
  );
});

test("L2-AC16: refreshAuthWith propagates a thrown error", async () => {
  const fakeCreate = async () => {
    throw new Error("network unreachable");
  };
  await assert.rejects(() =>
    refreshAuthWith("/auth.json", "anthropic", 100000, fakeCreate),
  );
});

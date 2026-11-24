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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { llmStub } from "../src/apps/cli/e2e-llm-stub-test-support.ts";

const ENGINE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAY_SCRIPT = join(ENGINE_ROOT, "scripts", "play-run-agent.mjs");
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");
const STUB_PROVIDER = "openai-compatible";
const STUB_MODEL_ID = "stub-1";
const TEST_K = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn";
const TEST_TIMEOUT_MS = 120000;
const SUCCESS = 0;
const MODE_MASK = 0o777;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SAMPLE_PROMPT_MARKER = "sum.mjs";

test(
  "L2-AC16: the play setup gives a workspace, a placeholder prompt and a run that works",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    assert.ok(existsSync(DIST_MAIN), "dist/main.js absent; run pnpm run build");

    const root = mkdtempSync(join(tmpdir(), "kanthord play'$test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const H = join(root, "h");
    const X = join(root, "x");
    const T = join(root, "tmp");
    const authDir = join(root, "cfg");
    mkdirSync(H);
    mkdirSync(X);
    mkdirSync(T);
    mkdirSync(authDir);

    const stub = await llmStub(t, [{ kind: "text", text: "ok" }], root);

    const authPath = join(authDir, "auth.json");
    const authEntry = {
      [STUB_PROVIDER]: {
        type: "api_key",
        key: TEST_K,
        env: {
          OPENAI_COMPATIBLE_BASE_URL: stub.baseUrl,
          OPENAI_COMPATIBLE_MODELS: JSON.stringify([{ id: STUB_MODEL_ID }]),
        },
      },
    };
    writeFileSync(authPath, JSON.stringify(authEntry));
    chmodSync(authPath, FILE_MODE);

    const env = {
      PATH: process.env.PATH ?? "",
      HOME: H,
      TMPDIR: T,
      XDG_STATE_HOME: X,
    };

    const playResult = spawnSync(
      process.execPath,
      [
        PLAY_SCRIPT,
        "--",
        "--model",
        `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`,
        "--auth",
        authPath,
        "--no-refresh",
      ],
      { cwd: ENGINE_ROOT, encoding: "utf8", timeout: TEST_TIMEOUT_MS, env },
    );

    assert.equal(playResult.status, SUCCESS, playResult.stderr);
    assert.ok(!playResult.stdout.includes(TEST_K), "play stdout holds TEST_K");
    assert.ok(!playResult.stderr.includes(TEST_K), "play stderr holds TEST_K");

    const runShPath = playResult.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("run.sh: "))
      .map((l) => l.slice("run.sh: ".length))
      .at(0);

    assert.ok(
      runShPath !== undefined,
      `run.sh path not found in:\n${playResult.stdout}`,
    );

    const playDir = join(runShPath, "..");
    assert.ok(playDir.startsWith(join(X, "kanthord", "play")), playDir);
    const playDirStat = statSync(playDir);
    assert.equal(
      playDirStat.mode & MODE_MASK,
      DIR_MODE,
      `play directory mode ${(playDirStat.mode & MODE_MASK).toString(8)}`,
    );

    const workspaceDir = join(playDir, "workspace");
    assert.ok(existsSync(workspaceDir), "workspace/ absent");

    const logResult = spawnSync(
      "git",
      ["-C", workspaceDir, "log", "--oneline"],
      {
        encoding: "utf8",
      },
    );
    const commits = logResult.stdout.trim().split("\n").filter(Boolean);
    assert.equal(commits.length, 1, `workspace has ${commits.length} commits`);

    const remoteResult = spawnSync("git", ["-C", workspaceDir, "remote"], {
      encoding: "utf8",
    });
    assert.equal(remoteResult.stdout.trim(), "", "workspace has remotes");

    const statusResult = spawnSync(
      "git",
      ["-C", workspaceDir, "status", "--porcelain"],
      { encoding: "utf8" },
    );
    assert.equal(statusResult.stdout.trim(), "", "workspace is not clean");

    const promptPath = join(playDir, "prompt.md");
    const promptText = readFileSync(promptPath, "utf8");
    assert.ok(
      promptText.includes(SAMPLE_PROMPT_MARKER),
      `prompt.md does not hold sample text:\n${promptText}`,
    );

    const runShChild = spawn(runShPath, [], { env });
    let runShStdout = "";
    let runShStderr = "";
    runShChild.stdout.on("data", (chunk) => {
      runShStdout += chunk;
    });
    runShChild.stderr.on("data", (chunk) => {
      runShStderr += chunk;
    });
    runShChild.stdin.end();
    const [runShStatus] = await once(runShChild, "close");

    assert.equal(
      runShStatus,
      SUCCESS,
      `run.sh failed\nstderr:\n${runShStderr}\nstdout:\n${runShStdout}`,
    );
    assert.ok(!runShStdout.includes(TEST_K), "run.sh stdout holds TEST_K");
    assert.ok(!runShStderr.includes(TEST_K), "run.sh stderr holds TEST_K");

    const userMessage = stub.requests
      .flatMap((r) => r.body?.input ?? [])
      .find((item) => item.role === "user");
    const userText = Array.isArray(userMessage?.content)
      ? userMessage.content.map((p) => p.text ?? "").join("")
      : String(userMessage?.content ?? "");
    assert.ok(
      userText.includes(promptText.trim()),
      `request does not hold prompt.md text`,
    );

    const resultPath = join(playDir, "result.jsonl");
    assert.ok(existsSync(resultPath), "result.jsonl absent");
    const resultLines = readFileSync(resultPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(
      resultLines.length,
      1,
      `result.jsonl has ${resultLines.length} lines`,
    );
    const result = JSON.parse(resultLines[0]);
    assert.equal(result.end, "completed");

    const sessionsDir = join(playDir, "sessions");
    assert.ok(existsSync(sessionsDir), "sessions/ absent");
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(
      sessionFiles.length,
      1,
      `sessions/ has ${sessionFiles.length} files`,
    );
    const sessionStat = statSync(join(sessionsDir, sessionFiles[0]));
    assert.equal(
      sessionStat.mode & MODE_MASK,
      FILE_MODE,
      `session file mode ${(sessionStat.mode & MODE_MASK).toString(8)}`,
    );
  },
);

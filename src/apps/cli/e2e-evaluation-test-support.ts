import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { temporary } from "../../kernel/test-support.ts";
import {
  mkdirAsTestUser,
  TEST_USER,
  TEST_USER_HOME,
  writeFileAsTestUser,
} from "./e2e-run-agent-linux-test-support.ts";
import type { StubTurn } from "./e2e-llm-stub-test-support.ts";
import type { RequestBody, RequestItem } from "./e2e-run-agent-test-support.ts";

const execFileAsync = promisify(execFile);

export interface EvalPaths {
  xd: string;
  xs: string;
  evalSetDir: string;
  authPath: string;
}

const STUB_PROVIDER = "openai-compatible";
const STUB_MODEL_ID = "stub-1";
const ROLE_SYSTEM = "system";
const ROLE_USER = "user";
const FUNCTION_CALL_OUTPUT = "function_call_output";

export function makeL4Responder(): (body: unknown) => StubTurn | undefined {
  return (body) => {
    const req = body as RequestBody;
    const input: RequestItem[] = req.input ?? [];

    const systemText = input
      .filter((item) => item.role === ROLE_SYSTEM)
      .map((item) => {
        if (!Array.isArray(item.content)) return String(item.content ?? "");
        return item.content.map((p) => p.text ?? "").join("");
      })
      .join("");

    const userText = input
      .filter((item) => item.role === ROLE_USER)
      .map((item) => {
        if (!Array.isArray(item.content)) return String(item.content ?? "");
        return item.content.map((p) => p.text ?? "").join("");
      })
      .join("");

    const functionOutputCount = input.filter(
      (item) => item.type === FUNCTION_CALL_OUTPUT,
    ).length;

    const isSwe = systemText.includes("swe@1");
    const isRe = systemText.includes("re@1");
    const isH1 = userText.includes("task h1");
    const isD1 = userText.includes("task d1");
    const isD2 = userText.includes("task d2");

    const usage = { input: 1000, output: 100 };

    if (isSwe && (isH1 || isD1)) {
      if (!functionOutputCount) {
        return {
          kind: "tool_calls",
          calls: [{ name: "write", args: { path: "ok.txt", content: "ok" } }],
          usage,
        };
      }
      return { kind: "text", text: "done", usage };
    }

    if (isSwe && isD2) {
      return { kind: "text", text: "done", usage };
    }

    if (isRe) {
      return {
        kind: "text",
        text: '{"findings":[{"aspect":"A5","evidence":"session.jsonl: no test run","severity":"medium"}]}',
        usage,
      };
    }

    return { kind: "text", text: "done", usage };
  };
}

async function runAsTestUser(
  script: string,
  arg: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("sudo", [
    "-n",
    "-u",
    TEST_USER,
    "sh",
    "-c",
    script,
    "sh",
    arg,
  ]);
  return { stdout: result.stdout, stderr: result.stderr };
}

const BUNDLE_CASE_SCRIPT = `
set -e
umask 077
DEST="$1"
mkdir -p "$DEST/check/tests/test"
REPO=$(mktemp -d)
trap 'rm -rf "$REPO"' EXIT
git -c init.defaultBranch=main init -q "$REPO"
mkdir -p "$REPO/test"
printf '%s' 'case' > "$REPO/README.md"
printf '%s' 'node_modules/' > "$REPO/.gitignore"
cat > "$REPO/test/old.sh" << 'INNER_EOF'
#!/bin/sh
exit 0
INNER_EOF
git -C "$REPO" add .
GIT_AUTHOR_DATE="2026-01-01T00:00:00+0000" GIT_COMMITTER_DATE="2026-01-01T00:00:00+0000" git -C "$REPO" -c user.name="Kanthor Eval" -c user.email="eval@kanthorlabs.invalid" commit -q -m "case"
COMMIT=$(git -C "$REPO" rev-parse HEAD)
printf '%s\n' "$COMMIT"
git -C "$REPO" bundle create "$DEST/repo.bundle" HEAD
echo ok > "$REPO/ok.txt"
git -C "$REPO" add ok.txt
git -C "$REPO" diff --cached --binary --no-renames --no-ext-diff --no-textconv --no-color "$COMMIT" > "$DEST/check/reference.patch"
cat > "$DEST/check/check.sh" << 'INNER_EOF'
#!/bin/sh
case "$2" in
  fail_to_pass) sh test/new.sh;;
  pass_to_pass) sh test/old.sh;;
  conventions) exit 0;;
esac
INNER_EOF
cat > "$DEST/check/tests/test/new.sh" << 'INNER_EOF'
#!/bin/sh
test "$(cat ok.txt 2>/dev/null)" = "ok"
INNER_EOF
cat > "$DEST/check/tests/test/old.sh" << 'INNER_EOF'
#!/bin/sh
exit 0
INNER_EOF
cat > "$DEST/setup.sh" << 'INNER_EOF'
#!/bin/sh
exit 0
INNER_EOF
`;

const INIT_EVAL_GIT_SCRIPT = `
set -e
umask 077
EVAL="$1"
git -c init.defaultBranch=main init -q "$EVAL"
`;

const COMMIT_EVAL_SCRIPT = `
set -e
EVAL="$1"
git -C "$EVAL" add .
GIT_AUTHOR_DATE="2026-01-01T00:00:00+0000" GIT_COMMITTER_DATE="2026-01-01T00:00:00+0000" git -C "$EVAL" -c user.name="Kanthor Eval" -c user.email="eval@kanthorlabs.invalid" commit -q -m "init"
git -C "$EVAL" rev-parse HEAD
`;

export async function buildEvaluationSet(
  t: TestContext,
  stubBaseUrl: string,
  testK: string,
): Promise<EvalPaths> {
  const root = temporary(t);
  const xd = join(root, "xd");
  const xs = join(root, "xs");

  await mkdirAsTestUser(xd);
  await mkdirAsTestUser(xs);

  const evalSetDir = join(xd, "kanthord", "evaluation", "agent");
  await mkdirAsTestUser(evalSetDir);

  const devD1Dir = join(evalSetDir, "cases", "dev", "d1");
  const devD2Dir = join(evalSetDir, "cases", "dev", "d2");
  const heldH1Dir = join(evalSetDir, "cases", "held-out", "h1");
  const bindingDir = join(evalSetDir, "binding");

  await mkdirAsTestUser(devD1Dir);
  await mkdirAsTestUser(devD2Dir);
  await mkdirAsTestUser(heldH1Dir);
  await mkdirAsTestUser(bindingDir);

  const { stdout: d1Commit } = await runAsTestUser(
    BUNDLE_CASE_SCRIPT,
    devD1Dir,
  );
  const { stdout: d2Commit } = await runAsTestUser(
    BUNDLE_CASE_SCRIPT,
    devD2Dir,
  );
  const { stdout: h1Commit } = await runAsTestUser(
    BUNDLE_CASE_SCRIPT,
    heldH1Dir,
  );

  const d1CommitTrimmed = d1Commit.trim().split("\n")[0];
  const d2CommitTrimmed = d2Commit.trim().split("\n")[0];
  const h1CommitTrimmed = h1Commit.trim().split("\n")[0];

  const models = JSON.stringify([{ id: STUB_MODEL_ID }]);

  const d1CaseJson = JSON.stringify({
    kind: "backend",
    commit: d1CommitTrimmed,
    wall: "10m",
    usd: "0.5usd",
    allowed: ["ok.txt"],
  });
  const d2CaseJson = JSON.stringify({
    kind: "frontend",
    commit: d2CommitTrimmed,
    wall: "10m",
    usd: "0.5usd",
    allowed: ["ok.txt"],
  });
  const h1CaseJson = JSON.stringify({
    kind: "backend",
    commit: h1CommitTrimmed,
    wall: "10m",
    usd: "0.5usd",
    allowed: ["ok.txt"],
  });

  await writeFileAsTestUser(join(devD1Dir, "case.json"), d1CaseJson);
  await writeFileAsTestUser(join(devD1Dir, "task.md"), "task d1\n");
  await writeFileAsTestUser(join(devD2Dir, "case.json"), d2CaseJson);
  await writeFileAsTestUser(join(devD2Dir, "task.md"), "task d2\n");
  await writeFileAsTestUser(join(heldH1Dir, "case.json"), h1CaseJson);
  await writeFileAsTestUser(join(heldH1Dir, "task.md"), "task h1\n");
  await writeFileAsTestUser(
    join(evalSetDir, "binding", "backend.md"),
    "# Binding\nbackend fixture\n",
  );
  await writeFileAsTestUser(
    join(evalSetDir, "binding", "frontend.md"),
    "# Binding\nfrontend fixture\n",
  );
  await writeFileAsTestUser(join(evalSetDir, ".gitignore"), "config.json\n");

  await runAsTestUser(INIT_EVAL_GIT_SCRIPT, evalSetDir);
  await runAsTestUser(COMMIT_EVAL_SCRIPT, evalSetDir);

  const configJson = JSON.stringify({
    cap_usd: 15,
    base_model: "openrouter/deepseek/deepseek-v4.1-flash",
    model: `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`,
    judge_model: `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`,
    judge_usd: "0.1usd",
    repeats: 2,
    gate_share: 0.5,
  });
  await writeFileAsTestUser(join(evalSetDir, "config.json"), configJson);

  const kanthordConfigDir = join(TEST_USER_HOME, ".config", "kanthord");
  const authPath = join(kanthordConfigDir, "auth.json");
  await mkdirAsTestUser(kanthordConfigDir);
  const authContent = JSON.stringify({
    [STUB_PROVIDER]: {
      type: "api_key",
      key: testK,
      env: {
        OPENAI_COMPATIBLE_BASE_URL: stubBaseUrl,
        OPENAI_COMPATIBLE_MODELS: models,
      },
    },
  });
  await writeFileAsTestUser(authPath, authContent);

  t.after(async () => {
    await runAsTestUser(`rm -f "$1"`, authPath);
  });

  return { xd, xs, evalSetDir, authPath };
}

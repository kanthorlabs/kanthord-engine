import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import {
  mkdirAsTestUser,
  TEST_USER,
  TEST_USER_HOME,
  writeFileAsTestUser,
} from "./e2e-run-agent-linux-test-support.ts";
import type { StubTurn } from "./e2e-llm-stub-test-support.ts";
import { authFileText, TEST_K } from "./e2e-run-agent-test-support.ts";
import type {
  CliResult,
  RequestBody,
  RequestItem,
} from "./e2e-run-agent-test-support.ts";

const execFileAsync = promisify(execFile);

export interface EvaluationFixture {
  xd: string;
  xs: string;
  set: string;
  runs: string;
}

export interface RunnerStart {
  script: string;
  args: string[];
  signal: AbortSignal;
}

interface FixtureCase {
  set: string;
  group: string;
  id: string;
  kind: string;
}

const ROLE_SYSTEM = "system";
const ROLE_USER = "user";
const TOOL_OUTPUT_TYPE = "function_call_output";
const SWE_ROLE = "Your role is `swe@1`";
const RE_ROLE = "Your role is `re@1`";
const WRITE_TASKS = ["task d1", "task h1"];
const TURN_USAGE = { input: 1000, output: 100 };
const DONE_TURN: StubTurn = { kind: "text", text: "done", usage: TURN_USAGE };
const WRITE_TURN: StubTurn = {
  kind: "tool_calls",
  calls: [{ name: "write", args: { path: "ok.txt", content: "ok" } }],
  usage: TURN_USAGE,
};
const FINDINGS_TURN: StubTurn = {
  kind: "text",
  text: '{"findings":[{"aspect":"A5","evidence":"session.jsonl: no test run","severity":"medium"}]}',
  usage: TURN_USAGE,
};

const CASE_SCRIPT = `
set -e
umask 077
DEST="$1"
mkdir -p "$DEST/check/tests/test"
REPO=$(mktemp -d)
trap 'rm -rf "$REPO"' EXIT
git -c init.defaultBranch=main init -q "$REPO"
mkdir -p "$REPO/test"
printf '%s' 'case' > "$REPO/README.md"
printf '%s\\n' 'node_modules/' > "$REPO/.gitignore"
printf '%s\\n' 'exit 0' > "$REPO/test/old.sh"
git -C "$REPO" add .
git -C "$REPO" -c user.name="Kanthor Eval" -c user.email="eval@kanthorlabs.invalid" commit -q -m case
COMMIT=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" bundle create -q "$DEST/repo.bundle" HEAD
printf '%s' 'ok' > "$REPO/ok.txt"
git -C "$REPO" add ok.txt
git -C "$REPO" diff --cached --binary "$COMMIT" > "$DEST/check/reference.patch"
printf '%s\\n' 'exit 0' > "$DEST/setup.sh"
printf '%s\\n' 'case "$2" in' '  fail_to_pass) sh test/new.sh;;' '  pass_to_pass) sh test/old.sh;;' '  conventions) exit 0;;' 'esac' > "$DEST/check/check.sh"
printf '%s\\n' 'test "$(cat ok.txt 2>/dev/null)" = "ok"' > "$DEST/check/tests/test/new.sh"
printf '%s\\n' 'exit 0' > "$DEST/check/tests/test/old.sh"
printf '%s' "$COMMIT"
`;

const SET_COMMIT_SCRIPT = `
set -e
umask 077
git -c init.defaultBranch=main init -q "$1"
git -C "$1" add .
git -C "$1" -c user.name="Kanthor Eval" -c user.email="eval@kanthorlabs.invalid" commit -q -m set
`;

function roleText(input: RequestItem[], role: string): string {
  return input
    .filter((item) => item.role === role)
    .map(({ content }) =>
      Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : (content ?? ""),
    )
    .join("");
}

function sweTurn(input: RequestItem[]): StubTurn {
  const task = roleText(input, ROLE_USER);
  const answered = input.some((item) => item.type === TOOL_OUTPUT_TYPE);
  const writes = WRITE_TASKS.some((text) => task.includes(text));
  return writes && !answered ? WRITE_TURN : DONE_TURN;
}

export function l4Responder(): (body: unknown) => StubTurn | undefined {
  return (body) => {
    const input = (body as RequestBody).input ?? [];
    const system = roleText(input, ROLE_SYSTEM);
    if (system.includes(SWE_ROLE)) return sweTurn(input);
    if (system.includes(RE_ROLE)) return FINDINGS_TURN;
    return undefined;
  };
}

export async function asTestUser(command: string[]): Promise<string> {
  const { stdout } = await execFileAsync("sudo", [
    "-n",
    "-u",
    TEST_USER,
    ...command,
  ]);
  return stdout;
}

async function buildCase(entry: FixtureCase): Promise<void> {
  const folder = join(entry.set, "cases", entry.group, entry.id);
  await mkdirAsTestUser(folder);
  const commit = await asTestUser(["sh", "-c", CASE_SCRIPT, "sh", folder]);
  await writeFileAsTestUser(join(folder, "task.md"), `task ${entry.id}\n`);
  await writeFileAsTestUser(
    join(folder, "case.json"),
    JSON.stringify({
      kind: entry.kind,
      commit,
      wall: "10m",
      usd: "0.5usd",
      allowed: ["ok.txt"],
    }),
  );
}

export async function buildEvaluationSet(
  t: TestContext,
  stubBaseUrl: string,
): Promise<EvaluationFixture> {
  const base = join(TEST_USER_HOME, `l4-${Date.now()}`);
  const configuration = join(TEST_USER_HOME, ".config");
  t.after(() => asTestUser(["rm", "-rf", base, configuration]));
  const xd = join(base, "xd");
  const xs = join(base, "xs");
  const set = join(xd, "kanthord", "evaluation", "agent");
  await mkdirAsTestUser(xs);
  await buildCase({ set, group: "dev", id: "d1", kind: "backend" });
  await buildCase({ set, group: "dev", id: "d2", kind: "frontend" });
  await buildCase({ set, group: "held-out", id: "h1", kind: "backend" });
  await writeFileAsTestUser(
    join(set, "binding", "backend.md"),
    "# Binding\n\nbackend fixture\n",
  );
  await writeFileAsTestUser(
    join(set, "binding", "frontend.md"),
    "# Binding\n\nfrontend fixture\n",
  );
  await writeFileAsTestUser(join(set, ".gitignore"), "config.json\n");
  await asTestUser(["sh", "-c", SET_COMMIT_SCRIPT, "sh", set]);
  await writeFileAsTestUser(
    join(set, "config.json"),
    JSON.stringify({
      cap_usd: 15,
      base_model: "openrouter/deepseek/deepseek-v4.1-flash",
      model: "openai-compatible/stub-1:off",
      judge_model: "openai-compatible/stub-1:off",
      judge_usd: "0.1usd",
      repeats: 2,
      gate_share: 0.5,
    }),
  );
  await writeFileAsTestUser(
    join(configuration, "kanthord", "auth.json"),
    authFileText(TEST_K, stubBaseUrl),
  );
  return { xd, xs, set, runs: join(xs, "kanthord", "evaluation", "runs") };
}

export async function runnerAsTestUser(
  fixture: EvaluationFixture,
  start: RunnerStart,
): Promise<CliResult> {
  const child = spawn(
    "sudo",
    [
      "-n",
      "-u",
      TEST_USER,
      "env",
      "-i",
      `PATH=${process.env.PATH ?? ""}`,
      `XDG_DATA_HOME=${fixture.xd}`,
      `XDG_STATE_HOME=${fixture.xs}`,
      "sh",
      start.script,
      ...start.args,
    ],
    { signal: start.signal },
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
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
}

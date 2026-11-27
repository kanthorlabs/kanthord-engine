import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { temporary } from "../kernel/test-support.ts";
import { createBashSandbox, hostDenyRead } from "./bash-sandbox.ts";

const execFileAsync = promisify(execFile);

const SANDBOX_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];
const SUCCESS = 0;
const COMMAND_TIMEOUT_MS = 100_000;
const CASE_TIMEOUT_MS = 120_000;
const SECRET_TEXT = "credential text of the deny list";
const SCRIPT_VARIABLE = "KANTHORD_SUITES_SCRIPT";
const AGENT_SUITE = "src/worker/unit/native-agent.test.ts";
const BASH_SANDBOX_MODULE = fileURLToPath(
  new URL("./bash-sandbox.ts", import.meta.url),
);
const LOOPBACK_SCRIPT = [
  'const net = require("node:net");',
  "const fail = (step, error) => { console.log(`${step} ${error.code}`); process.exit(1); };",
  "const server = net.createServer((socket) => socket.end('pong'));",
  "server.on('error', (error) => fail('listen', error));",
  "server.listen(0, '127.0.0.1', () => {",
  "  const client = net.connect(server.address().port, '127.0.0.1');",
  "  client.on('error', (error) => fail('connect', error));",
  "  client.on('data', (data) => { console.log(`connected ${data}`); client.destroy(); server.close(); });",
  "});",
].join("\n");
const NESTED_SCRIPT = [
  'import { execFileSync } from "node:child_process";',
  'import { SandboxManager } from "@anthropic-ai/sandbox-runtime";',
  `import { createBashSandbox } from ${JSON.stringify(BASH_SANDBOX_MODULE)};`,
  "const sandbox = createBashSandbox(SandboxManager);",
  "try {",
  '  const wrapped = await sandbox.wrap("true", process.cwd(), { env: process.env, denyRead: [] });',
  '  execFileSync("bash", ["-c", wrapped], { stdio: "inherit" });',
  '  console.log("nested wrap of true ran");',
  "} finally {",
  "  await sandbox.dispose();",
  "}",
].join("\n");

interface Outcome {
  status: number;
  output: string;
}

interface Host {
  cwd: string;
  env: NodeJS.ProcessEnv;
  denyRead: string[];
  secret: string;
}

function isExitCode(code: unknown): code is number {
  return Number.isInteger(code);
}

async function execute(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd,
      env,
      timeout: COMMAND_TIMEOUT_MS,
      encoding: "utf8",
    });
    return { status: SUCCESS, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    if (!isExitCode(failure.code)) throw error;
    return {
      status: failure.code,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

const sandbox = createBashSandbox(SandboxManager);

async function inSandbox(h: Host, command: string): Promise<Outcome> {
  const wrapped = await sandbox.wrap(command, h.cwd, {
    env: h.env,
    denyRead: h.denyRead,
  });
  try {
    return await execute(wrapped, h.cwd, h.env);
  } finally {
    sandbox.cleanup();
  }
}

async function sandboxUnavailable(): Promise<string | false> {
  if (!SANDBOX_PLATFORMS.includes(platform()))
    return `the bash sandbox runs on darwin and linux, not on ${platform()}`;
  try {
    const wrapped = await sandbox.wrap("true", process.cwd(), {
      env: process.env,
      denyRead: hostDenyRead(process.env),
    });
    const probe = await execute(wrapped, process.cwd(), process.env).finally(
      () => sandbox.cleanup(),
    );
    return probe.status === SUCCESS
      ? false
      : `the sandbox cannot run a command: ${probe.output.trim()}`;
  } catch (error) {
    return `the sandbox cannot start: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const unavailable = await sandboxUnavailable();

after(() => sandbox.dispose());

function lastLine(outcome: Outcome): string {
  return outcome.output.trim().split("\n").at(-1) ?? "";
}

function host(t: TestContext, script?: string, workdir?: string): Host {
  const root = realpathSync(temporary(t));
  const tmp = join(root, "tmp");
  const data = join(root, "data");
  const work = join(root, "work");
  for (const directory of [tmp, data, work]) mkdirSync(directory);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: tmp,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    ...(script === undefined ? {} : { [SCRIPT_VARIABLE]: script }),
  };
  const secret = join(data, "kanthord", "secret.txt");
  mkdirSync(join(data, "kanthord"));
  writeFileSync(secret, SECRET_TEXT);
  return { cwd: workdir ?? work, env, denyRead: hostDenyRead(env), secret };
}

function record(t: TestContext, command: string, outcome: Outcome): string {
  const line = `${command}: ${platform()}, exit ${outcome.status}, ${lastLine(outcome)}`;
  t.diagnostic(line);
  return line;
}

function assertBlocked(
  t: TestContext,
  command: string,
  outcome: Outcome,
  blocked: boolean,
): void {
  const line = record(t, command, outcome);
  if (blocked) assert.notEqual(outcome.status, SUCCESS, line);
  else assert.equal(outcome.status, SUCCESS, line);
}

test(
  "(edge) H1: a sandboxed node script binds a loopback port and connects to it",
  {
    skip: unavailable,
    timeout: CASE_TIMEOUT_MS,
  },
  async (t) => {
    const h = host(t, LOOPBACK_SCRIPT);
    const command = `node -e "$${SCRIPT_VARIABLE}"`;
    assertBlocked(t, command, await inSandbox(h, command), false);
  },
);

test(
  `(edge) H3: a sandboxed node --test ${AGENT_SUITE}`,
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = host(t, undefined, process.cwd());
    const command = `node --test ${AGENT_SUITE}`;
    assertBlocked(t, command, await inSandbox(h, command), false);
  },
);

test(
  "(edge) H3: a nested wrap of true inside the sandbox",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = host(t, NESTED_SCRIPT, process.cwd());
    const command = `node --input-type=module -e "$${SCRIPT_VARIABLE}"`;
    assertBlocked(t, command, await inSandbox(h, command), true);
  },
);

test(
  "(invariant guard) a sandboxed cat of a file of the deny list fails",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = host(t);
    const command = `cat ${h.secret}`;
    const outcome = await inSandbox(h, command);
    assert.ok(
      !outcome.output.includes(SECRET_TEXT),
      record(t, command, outcome),
    );
    assertBlocked(t, command, outcome, true);
  },
);

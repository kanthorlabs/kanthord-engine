import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { basename, join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import type {
  StubRequestRecord,
  StubTurn,
} from "./e2e-llm-stub-test-support.ts";
import {
  authFileText,
  blockTexts,
  buildFixtures,
  digestListing,
  ENGINE_ROOT,
  requestBody,
  resultLines,
  roleText,
  sessionMessages,
  spawnCli,
  TEST_K,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";
import type { AgentFixtures } from "./e2e-run-agent-test-support.ts";
import {
  buildWorkspaceAsTestUser,
  flushNftConnections,
  mkdirAsTestUser,
  nftConnections,
  spawnBinAsTestUser,
  spawnCliAsTestUser,
  TEST_USER,
  TEST_USER_HOME,
  writeFileAsTestUser,
} from "./e2e-run-agent-linux-test-support.ts";

const execFileAsync = promisify(execFile);

const DNS_HOST = "192.0.2.53";
const DNS_PORT = 53;
const STUB_TEXT = "ok";
const SUCCESS_EXIT = 0;
const EMPTY_OUTPUT = "";
const STUB_CALL_COUNT = 1;
const LOOPBACK = "127.0.0.1";
const TEST_HOST = "192.0.2.1";
const TEST_PORT = 443;
const HOMEDIR_SCRIPT =
  'process.stdout.write(require("node:os").userInfo().homedir)';
const PI_TOOLS = ["fd", "rg"];
const PI_TOOLS_BIN = join(
  ENGINE_ROOT,
  ".pi-tools",
  `${process.platform}-${process.arch}`,
  "bin",
);
const FIXTURE_DIRECTORY = join(TEST_USER_HOME, ".kanthord-self-test");
const FIXTURE_PATH = join(FIXTURE_DIRECTORY, "nested", "fixture.json");
const FIXTURE_TEXT = '{"fixture":true}';
const FIXTURE_STAT = `600 ${TEST_USER}`;

function asTestUser(command: string[]): Promise<{ stdout: string }> {
  return execFileAsync("sudo", ["-n", "-u", TEST_USER, ...command]);
}

test(
  "stub answers a scripted request on loopback inside the namespace and the set holds its address and port",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: STUB_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const result = await spawnCli(fixtures, { signal: t.signal });
    assert.equal(result.status, SUCCESS_EXIT, result.stderr);
    assert.equal(stub.requests.length, STUB_CALL_COUNT);
    const connections = await nftConnections();
    assert.ok(
      connections.some(
        ({ address, port }) =>
          address === LOOPBACK && port === Number(new URL(stub.baseUrl).port),
      ),
      JSON.stringify(connections),
    );
  },
);

test(
  "a connection to 192.0.2.1:443 fails and the set holds its address and port",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const socket = createConnection(TEST_PORT, TEST_HOST);
    await assert.rejects(once(socket, "connect"));
    socket.destroy();

    const connections = await nftConnections();
    assert.ok(
      connections.some(
        ({ address, port }) => address === TEST_HOST && port === TEST_PORT,
      ),
      JSON.stringify(connections),
    );
  },
);

test(
  "os.userInfo().homedir of the test user is /home/kanthord-e2e",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { stdout } = await asTestUser([
      process.execPath,
      "-e",
      HOMEDIR_SCRIPT,
    ]);
    assert.equal(stdout, TEST_USER_HOME);
  },
);

test(
  "the test user starts bin/kanthord.mjs with an explicit environment",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const result = await spawnBinAsTestUser({
      args: ["--version"],
      env: { HOME: TEST_USER_HOME },
      signal: t.signal,
    });
    assert.equal(result.status, SUCCESS_EXIT, result.stderr);
    assert.equal(result.stderr, EMPTY_OUTPUT);
    assert.notEqual(result.stdout, EMPTY_OUTPUT);
  },
);

test(
  "the test user reads and executes each pi tool",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const tool of PI_TOOLS) {
      const path = join(PI_TOOLS_BIN, tool);
      await asTestUser(["test", "-r", path, "-a", "-x", path]);
    }
  },
);

test(
  "a fixture file of the test user has the mode 0600 and the given text",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    t.after(() => asTestUser(["rm", "-rf", FIXTURE_DIRECTORY]));
    await writeFileAsTestUser(FIXTURE_PATH, FIXTURE_TEXT);
    const stat = await asTestUser(["stat", "-c", "%a %U", FIXTURE_PATH]);
    assert.equal(stat.stdout.trim(), FIXTURE_STAT);
    const text = await asTestUser(["cat", FIXTURE_PATH]);
    assert.equal(text.stdout, FIXTURE_TEXT);
  },
);

test(
  "a UDP send to 192.0.2.53:53 is recorded in the connections set",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.send(Buffer.alloc(1), DNS_PORT, DNS_HOST, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    socket.close();
    const connections = await nftConnections();
    assert.ok(
      connections.some(
        ({ address, port }) => address === DNS_HOST && port === DNS_PORT,
      ),
      JSON.stringify(connections),
    );
  },
);

const MARKER_WORKER = "marker-kanthord-worker-config-ac2-xjk29";
const MARKER_MACHINE = "marker-kanthord-machine-config-ac2-xjk29";
const MARKER_TOKEN = "marker-kanthord-token-ac2-xjk29";
const MARKER_ANTHROPIC = "marker-anthropic-api-key-ac2-xjk29";
const MARKER_AWS_KEY = "marker-aws-access-key-id-ac2-xjk29";
const MARKER_AWS_SECRET = "marker-aws-secret-access-key-ac2-xjk29";
const MARKER_AWS_PROFILE = "marker-aws-profile-ac2-xjk29";
const MARKER_AWS_IDENTITY = "marker-aws-web-identity-ac2-xjk29";
const MARKER_AWS_CONTAINER = "marker-aws-container-creds-uri-ac2-xjk29";
const MARKER_OPENAI_KEY = "marker-openai-api-key-ac2-xjk29";
const MARKER_AWS_CREDS = "marker-aws-credentials-file-ac2-xjk29";
const AC2_MARKERS = [
  MARKER_WORKER,
  MARKER_MACHINE,
  MARKER_TOKEN,
  MARKER_ANTHROPIC,
  MARKER_AWS_KEY,
  MARKER_AWS_SECRET,
  MARKER_AWS_PROFILE,
  MARKER_AWS_IDENTITY,
  MARKER_AWS_CONTAINER,
  MARKER_OPENAI_KEY,
  MARKER_AWS_CREDS,
];
const M1_AC2 = "prompt-m1-unique-for-l2-ac2-run1";
const M2_AC2 = "prompt-m2-unique-for-l2-ac2-run2";
const AC2_S1 = "s1.jsonl";
const AC2_S2 = "s2.jsonl";
const AC2_O = "results.jsonl";
const AC2_COMMAND = "env; cat ~/.aws/credentials";
const AC2_REQUEST_COUNT = 4;
const AC2_RUN2_FIRST_REQUEST = 2;
const TOOL_RESULT_ROLE = "toolResult";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const BASH_TOOL_NAME = "bash";
const KANTHORD_PREFIX = "KANTHORD_";
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const CHILD_ENV_NAMES = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_SSH_COMMAND",
  "HOME",
  "LANG",
  "PATH",
  "PWD",
  "SHLVL",
  "TMPDIR",
  "_",
];
const SINGLE = 1;
const RUN1_RESULT_COUNT = 1;
const RUN2_RESULT_COUNT = 2;
const NO_CONNECTIONS = 0;
const PI_TOOLS_MANIFEST = join(ENGINE_ROOT, "static", "pi-tools.json");
const PI_TOOLS_TARGET = `${process.platform}-${process.arch}`;

interface PiToolTarget {
  license_paths: string[];
}

interface PiToolEntry {
  targets: Record<string, PiToolTarget>;
}

interface PiToolsManifest {
  tools: Record<string, PiToolEntry>;
}

function hostileEnvironment(stub2Url: string): Record<string, string> {
  return {
    LANG: "C",
    KANTHORD_WORKER_CONFIG: MARKER_WORKER,
    KANTHORD_MACHINE_CONFIG: MARKER_MACHINE,
    KANTHORD_TOKEN: MARKER_TOKEN,
    KANTHORD_ENDPOINT: stub2Url,
    ANTHROPIC_API_KEY: MARKER_ANTHROPIC,
    AWS_ACCESS_KEY_ID: MARKER_AWS_KEY,
    AWS_SECRET_ACCESS_KEY: MARKER_AWS_SECRET,
    AWS_PROFILE: MARKER_AWS_PROFILE,
    AWS_WEB_IDENTITY_TOKEN_FILE: MARKER_AWS_IDENTITY,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: MARKER_AWS_CONTAINER,
    OPENAI_API_KEY: MARKER_OPENAI_KEY,
    AZURE_OPENAI_BASE_URL: stub2Url,
    OPENAI_BASE_URL: stub2Url,
    HTTP_PROXY: stub2Url,
    http_proxy: stub2Url,
    HTTPS_PROXY: stub2Url,
    https_proxy: stub2Url,
    ALL_PROXY: stub2Url,
    all_proxy: stub2Url,
    NO_PROXY: stub2Url,
    no_proxy: stub2Url,
  };
}

function requestText(record: StubRequestRecord): string {
  return JSON.stringify({ headers: record.headers, body: record.body });
}

function holdsAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entryListing(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[]).sort();
}

function piToolFiles(): string[] {
  const manifest = JSON.parse(
    readFileSync(PI_TOOLS_MANIFEST, "utf8"),
  ) as PiToolsManifest;
  return Object.entries(manifest.tools)
    .flatMap(([tool, entry]) => [
      join("bin", tool),
      ...(entry.targets[PI_TOOLS_TARGET]?.license_paths ?? []).map((license) =>
        join("bin", "licenses", tool, basename(license)),
      ),
    ])
    .sort();
}

function fileListing(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

function roleCount(record: StubRequestRecord, role: string): number {
  return (requestBody(record).input ?? []).filter((item) => item.role === role)
    .length;
}

function bashOutput(sessionPath: string): string {
  const results = sessionMessages(sessionPath, TOOL_RESULT_ROLE).filter(
    (message) => message.toolName === BASH_TOOL_NAME,
  );
  assert.equal(results.length, SINGLE);
  return blockTexts(results[0]!).join("");
}

function envNames(output: string): string[] {
  return output
    .split("\n")
    .flatMap((line) => ENV_LINE.exec(line)?.[1] ?? [])
    .sort();
}

test(
  "L2-AC2: two runs in a hostile environment leave no state and leak nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const bashTurn: StubTurn = {
      kind: "tool_calls",
      calls: [{ name: BASH_TOOL_NAME, args: { command: AC2_COMMAND } }],
    };
    const stub = await llmStub(
      t,
      [
        bashTurn,
        { kind: "text", text: "run1-done" },
        bashTurn,
        { kind: "text", text: "run2-done" },
      ],
      "",
    );
    const stub2 = await llmStub(t, [], "");
    const stubUrl = new URL(stub.baseUrl);

    const fixtures = await buildFixtures(t, stub.baseUrl);
    mkdirSync(join(fixtures.H, ".aws"), { mode: 0o700 });
    writeFileSync(join(fixtures.H, ".aws", "credentials"), MARKER_AWS_CREDS, {
      mode: 0o600,
    });

    const piPath = join(fixtures.X, "kanthord", "pi");
    const hEntries = entryListing(fixtures.H);
    const hDigests = digestListing(fixtures.H);
    const authDigest = fileDigest(fixtures.authPath);
    const authMode = statSync(fixtures.authPath).mode;
    const piFiles = piToolFiles();
    const piDigests: string[][] = [];
    const runs = [
      { prompt: M1_AC2, session: AC2_S1, results: RUN1_RESULT_COUNT },
      { prompt: M2_AC2, session: AC2_S2, results: RUN2_RESULT_COUNT },
    ];
    const sessions: string[] = [];

    await flushNftConnections();

    for (const run of runs) {
      sessions.push(run.session);
      const result = await spawnCli(fixtures, {
        prompt: [run.prompt],
        session: join(fixtures.D, run.session),
        extraEnv: hostileEnvironment(stub2.baseUrl),
        signal: t.signal,
      });
      assert.equal(result.status, SUCCESS_EXIT, result.stderr);

      assert.deepEqual(entryListing(fixtures.H), hEntries);
      assert.deepEqual(digestListing(fixtures.H), hDigests);
      assert.deepEqual(
        readdirSync(fixtures.D).sort(),
        [AC2_O, ...sessions].sort(),
      );
      assert.equal(resultLines(fixtures.O).length, run.results);
      assert.deepEqual(fileListing(piPath), piFiles);
      piDigests.push(digestListing(piPath));
      assert.deepEqual(readdirSync(fixtures.T), []);
      assert.equal(fileDigest(fixtures.authPath), authDigest);
      assert.equal(statSync(fixtures.authPath).mode, authMode);
    }
    assert.deepEqual(piDigests[1], piDigests[0]);

    assert.equal(stub2.connectionCount(), NO_CONNECTIONS);
    assert.deepEqual(await nftConnections(), [
      { address: stubUrl.hostname, port: Number(stubUrl.port) },
    ]);

    assert.equal(stub.requests.length, AC2_REQUEST_COUNT);
    for (const request of stub.requests) {
      assert.ok(!holdsAny(requestText(request), AC2_MARKERS));
      assert.equal(request.headers["authorization"], `Bearer ${TEST_K}`);
    }

    for (const session of sessions) {
      const sessionPath = join(fixtures.D, session);
      assert.ok(!holdsAny(readFileSync(sessionPath, "utf8"), AC2_MARKERS));
      const output = bashOutput(sessionPath);
      assert.ok(!holdsAny(output, AC2_MARKERS), output);
      assert.ok(!output.includes(KANTHORD_PREFIX), output);
      assert.deepEqual(envNames(output), CHILD_ENV_NAMES, output);
    }

    const run2First = stub.requests[AC2_RUN2_FIRST_REQUEST]!;
    assert.ok(!requestText(run2First).includes(M1_AC2));
    assert.equal(roleCount(run2First, SYSTEM_ROLE), SINGLE);
    assert.equal(roleCount(run2First, USER_ROLE), SINGLE);
    assert.equal(roleText(run2First, USER_ROLE), M2_AC2);
  },
);

const K2_AC6 = "K2DecoyForL2Ac6PiDirAuthKey12345";
const K3_AC6 = "K3DecoyForL2Ac6HomeVarKey1234567";
const K4_AC6 = "K4DecoyForL2Ac6XdgConfigKey12345";
const K5_AC6 = "K5DecoyForL2Ac6PiAgentKey1234567";
const K6_AC6 = "K6DecoyForL2Ac6StdinKey123456789";
const T1_AC6 = "T1DecoyForL2Ac6KanthordTokenXyz1";
const T2_AC6 = "T2DecoyForL2Ac6CliYamlTokenXyz12";
const AC6_DECOYS = [K2_AC6, K3_AC6, K4_AC6, K5_AC6, K6_AC6, T1_AC6, T2_AC6];
const AC6_PROVIDER = "openai-compatible";
const AC6_AUTH = join(".config", "kanthord", "auth.json");
const AC6_FIND_SCRIPT = 'find "$1" -mindepth 1 -path "$2" -prune -o -print';

async function homeListing(base: string): Promise<string[]> {
  const { stdout } = await asTestUser([
    "sh",
    "-c",
    AC6_FIND_SCRIPT,
    "sh",
    TEST_USER_HOME,
    base,
  ]);
  return stdout.split("\n").filter(Boolean).sort();
}

test(
  "L2-AC6: the credential comes only from the --auth file",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(
      t,
      [
        { kind: "text", text: "done-v1" },
        { kind: "text", text: "done-v2" },
        { kind: "text", text: "done-v3" },
      ],
      "",
    );

    const H = TEST_USER_HOME;
    const base = join(H, `l2-ac6-${Date.now()}`);
    t.after(() =>
      asTestUser(["rm", "-rf", base, join(H, ".config"), join(H, ".pi")]),
    );

    const T = join(base, "tmp");
    const X = join(base, "x");
    const D2 = join(base, "d2");
    const H2 = join(base, "h2");
    const X2 = join(base, "x2");
    await mkdirAsTestUser(T);
    await mkdirAsTestUser(X);

    const authPath = join(H, AC6_AUTH);
    await writeFileAsTestUser(authPath, authFileText(TEST_K, stub.baseUrl));
    await writeFileAsTestUser(
      join(D2, "auth.json"),
      authFileText(K2_AC6, stub.baseUrl),
    );
    await writeFileAsTestUser(
      join(H2, AC6_AUTH),
      authFileText(K3_AC6, stub.baseUrl),
    );
    await writeFileAsTestUser(
      join(X2, "kanthord", "auth.json"),
      authFileText(K4_AC6, stub.baseUrl),
    );
    await writeFileAsTestUser(
      join(H, ".pi", "agent", "auth.json"),
      authFileText(K5_AC6, stub.baseUrl),
    );
    await writeFileAsTestUser(
      join(H, ".config", "kanthord", "cli.yaml"),
      `token: ${T2_AC6}\n`,
    );
    const stdin = JSON.stringify({
      provider_id: AC6_PROVIDER,
      credential: { type: "api_key", key: K6_AC6 },
    });

    const variants: Record<string, string>[] = [
      {},
      { HOME: H2 },
      { XDG_CONFIG_HOME: X2 },
    ];
    const homeBefore = await homeListing(base);
    const sessions: string[] = [];

    for (const [index, variant] of variants.entries()) {
      const W = join(base, `w${index}`);
      const D = join(base, `d${index}`);
      await buildWorkspaceAsTestUser(W);
      await mkdirAsTestUser(D);
      const fixtures: AgentFixtures = {
        authPath,
        W,
        H,
        X,
        T,
        D,
        S: join(D, "s.jsonl"),
        O: join(D, "results.jsonl"),
        TEST: base,
        K: TEST_K,
      };
      sessions.push(fixtures.S);

      const result = await spawnCliAsTestUser(
        fixtures,
        {
          auth: false,
          extraEnv: {
            PI_CODING_AGENT_DIR: D2,
            KANTHORD_TOKEN: T1_AC6,
            ...variant,
          },
          signal: t.signal,
        },
        stdin,
      );
      assert.equal(result.status, SUCCESS_EXIT, result.stderr);
    }

    assert.equal(stub.requests.length, variants.length);
    for (const request of stub.requests) {
      assert.equal(request.headers["authorization"], `Bearer ${TEST_K}`);
      assert.ok(!holdsAny(requestText(request), AC6_DECOYS));
    }
    for (const session of sessions) {
      const { stdout } = await asTestUser(["cat", session]);
      assert.notEqual(stdout, EMPTY_OUTPUT);
      assert.ok(!holdsAny(stdout, AC6_DECOYS));
    }
    assert.deepEqual(await homeListing(base), homeBefore);
  },
);

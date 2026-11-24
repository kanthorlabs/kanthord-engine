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
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  blockTexts,
  buildFixtures,
  digestListing,
  ENGINE_ROOT,
  resultLines,
  sessionMessages,
  spawnCli,
  TEST_K,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";
import {
  buildWorkspaceAsTestUser,
  mkdirAsTestUser,
  nftConnections,
  spawnBinAsTestUser,
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
const TOOL_RESULT_ROLE = "toolResult";
const BASH_TOOL_NAME = "bash";
const RUN1_RESULT_COUNT = STUB_CALL_COUNT;
const RUN2_RESULT_COUNT = STUB_CALL_COUNT * 2;
const NO_ENTRIES = 0;

function hostiletEnv(stub2Url: string): Record<string, string> {
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

function requestText(record: {
  headers: Record<string, unknown>;
  body: unknown;
}): string {
  return JSON.stringify({ headers: record.headers, body: record.body });
}

function holdsAnyMarker(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function sudoRead(path: string): Promise<string> {
  const { stdout } = await execFileAsync("sudo", ["cat", path]);
  return stdout;
}

test(
  "L2-AC2: two runs in a hostile environment leave no state and leak nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const bashTurn = {
      kind: "tool_calls" as const,
      calls: [
        {
          name: BASH_TOOL_NAME,
          args: { command: "env; cat ~/.aws/credentials" },
        },
      ],
    };
    const textTurn1 = { kind: "text" as const, text: "run1-done" };
    const textTurn2 = { kind: "text" as const, text: "run2-done" };
    const stub = await llmStub(
      t,
      [bashTurn, textTurn1, bashTurn, textTurn2],
      "",
    );
    const stub2 = await llmStub(t, [], "");

    const fixtures = await buildFixtures(t, stub.baseUrl);
    mkdirSync(join(fixtures.H, ".aws"), { mode: 0o700, recursive: true });
    writeFileSync(join(fixtures.H, ".aws", "credentials"), MARKER_AWS_CREDS, {
      mode: 0o600,
    });

    const hListingBefore = digestListing(fixtures.H);
    const preConnections = await nftConnections();
    const authDigestBefore = fileDigest(fixtures.authPath);
    const authModeBefore = statSync(fixtures.authPath).mode;

    const s1Path = join(fixtures.D, AC2_S1);
    const s2Path = join(fixtures.D, AC2_S2);
    const piPath = join(fixtures.X, "kanthord", "pi");

    const result1 = await spawnCli(fixtures, {
      prompt: [M1_AC2],
      session: s1Path,
      extraEnv: hostiletEnv(stub2.baseUrl),
      signal: t.signal,
    });
    assert.equal(result1.status, SUCCESS_EXIT, result1.stderr);

    assert.deepEqual(digestListing(fixtures.H), hListingBefore);
    assert.deepEqual(readdirSync(fixtures.D).sort(), [AC2_O, AC2_S1]);
    assert.equal(resultLines(fixtures.O).length, RUN1_RESULT_COUNT);
    const pListingAfterRun1 = digestListing(piPath);
    assert.equal(readdirSync(fixtures.T).length, NO_ENTRIES);

    const result2 = await spawnCli(fixtures, {
      prompt: [M2_AC2],
      session: s2Path,
      extraEnv: hostiletEnv(stub2.baseUrl),
      signal: t.signal,
    });
    assert.equal(result2.status, SUCCESS_EXIT, result2.stderr);

    assert.deepEqual(digestListing(fixtures.H), hListingBefore);
    assert.deepEqual(readdirSync(fixtures.D).sort(), [AC2_O, AC2_S1, AC2_S2]);
    assert.equal(resultLines(fixtures.O).length, RUN2_RESULT_COUNT);
    assert.deepEqual(digestListing(piPath), pListingAfterRun1);
    assert.equal(readdirSync(fixtures.T).length, NO_ENTRIES);

    assert.equal(stub2.requests.length, NO_ENTRIES);

    const postConnections = await nftConnections();
    const preSet = new Set(
      preConnections.map(({ address, port }) => `${address}:${port}`),
    );
    const stubAddr = new URL(stub.baseUrl).hostname;
    const stubPort = Number(new URL(stub.baseUrl).port);
    const newConns = postConnections.filter(
      ({ address, port }) => !preSet.has(`${address}:${port}`),
    );
    for (const { address, port } of newConns) {
      assert.equal(
        address,
        stubAddr,
        `unexpected connection to ${address}:${port}`,
      );
      assert.equal(
        port,
        stubPort,
        `unexpected connection to ${address}:${port}`,
      );
    }

    for (const req of stub.requests) {
      const text = requestText(req);
      assert.ok(
        !holdsAnyMarker(text, AC2_MARKERS),
        `request holds a marker: ${text.slice(0, 200)}`,
      );
      assert.ok(
        String(req.headers["authorization"] ?? "").includes(TEST_K),
        `request does not carry K: ${String(req.headers["authorization"])}`,
      );
    }

    for (const sf of [s1Path, s2Path]) {
      const sfText = readFileSync(sf, "utf8");
      assert.ok(
        !holdsAnyMarker(sfText, AC2_MARKERS),
        `session file holds a marker: ${sf}`,
      );
    }

    const bashResults1 = sessionMessages(s1Path, TOOL_RESULT_ROLE).filter(
      (m) => m.toolName === BASH_TOOL_NAME,
    );
    const bashResults2 = sessionMessages(s2Path, TOOL_RESULT_ROLE).filter(
      (m) => m.toolName === BASH_TOOL_NAME,
    );
    for (const msg of [...bashResults1, ...bashResults2]) {
      const text = blockTexts(msg).join("");
      assert.ok(
        !holdsAnyMarker(text, AC2_MARKERS),
        `bash result holds a marker: ${text.slice(0, 200)}`,
      );
      assert.ok(
        !text.includes("KANTHORD_"),
        `bash result holds a KANTHORD_ name: ${text.slice(0, 200)}`,
      );
    }

    const req2First = stub.requests[2];
    assert.ok(req2First !== undefined);
    const req2Body = requestText(req2First);
    assert.ok(!req2Body.includes(M1_AC2), "first request of run 2 holds M1");

    assert.equal(fileDigest(fixtures.authPath), authDigestBefore);
    assert.equal(statSync(fixtures.authPath).mode, authModeBefore);
  },
);

const K2_AC6 = "K2DecoyForL2Ac6PiDirAuthKey12345";
const K3_AC6 = "K3DecoyForL2Ac6HomeVarKey1234567";
const K4_AC6 = "K4DecoyForL2Ac6XdgConfigKey12345";
const K5_AC6 = "K5DecoyForL2Ac6PiAgentKey1234567";
const K6_AC6 = "K6DecoyForL2Ac6StdinKey123456789";
const T1_AC6 = "T1DecoyForL2Ac6KanthordTokenXyz1";
const T2_AC6 = "T2DecoyForL2Ac6CliYamlTokenXyz12";
const AC6_ALL_DECOYS = [K2_AC6, K3_AC6, K4_AC6, K5_AC6, K6_AC6, T1_AC6, T2_AC6];

const STUB_MODEL_ID = "stub-1";
const STUB_PROVIDER = "openai-compatible";

function ac6AuthJson(key: string, baseUrl: string): string {
  return JSON.stringify({
    [STUB_PROVIDER]: {
      type: "api_key",
      key,
      env: {
        OPENAI_COMPATIBLE_BASE_URL: baseUrl,
        OPENAI_COMPATIBLE_MODELS: JSON.stringify([{ id: STUB_MODEL_ID }]),
      },
    },
  });
}

function ac6SimpleAuthJson(key: string): string {
  return JSON.stringify({
    [STUB_PROVIDER]: { type: "api_key", key, env: {} },
  });
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
    const baseDir = join(H, `ac6-test-${Date.now()}`);
    t.after(async () => {
      await execFileAsync("sudo", [
        "-n",
        "-u",
        TEST_USER,
        "rm",
        "-rf",
        baseDir,
      ]);
      await execFileAsync("sudo", [
        "-n",
        "-u",
        TEST_USER,
        "rm",
        "-rf",
        join(H, ".config"),
        join(H, ".pi"),
      ]);
    });

    await mkdirAsTestUser(join(baseDir, "tmp"));
    await mkdirAsTestUser(join(baseDir, "x"));

    const T = join(baseDir, "tmp");
    const X = join(baseDir, "x");

    const authJson = ac6AuthJson(TEST_K, stub.baseUrl);
    await writeFileAsTestUser(
      join(H, ".config", "kanthord", "auth.json"),
      authJson,
    );
    await writeFileAsTestUser(
      join(H, ".pi", "agent", "auth.json"),
      ac6SimpleAuthJson(K5_AC6),
    );
    await writeFileAsTestUser(
      join(H, ".config", "kanthord", "cli.yaml"),
      `token: ${T2_AC6}\n`,
    );

    const piDirAuth = join(baseDir, "pidir");
    await writeFileAsTestUser(
      join(piDirAuth, "auth.json"),
      ac6SimpleAuthJson(K2_AC6),
    );

    const H2 = join(baseDir, "h2");
    await writeFileAsTestUser(
      join(H2, ".config", "kanthord", "auth.json"),
      ac6SimpleAuthJson(K3_AC6),
    );

    const X2 = join(baseDir, "x2");
    await writeFileAsTestUser(
      join(X2, "kanthord", "auth.json"),
      ac6SimpleAuthJson(K4_AC6),
    );

    const stdinPayload = JSON.stringify({
      provider_id: STUB_PROVIDER,
      credential: { type: "api_key", key: K6_AC6 },
    });

    const variants: Array<{ home: string; extraEnv?: Record<string, string> }> =
      [
        { home: H },
        { home: H2 },
        { home: H, extraEnv: { XDG_CONFIG_HOME: X2 } },
      ];

    let reqIndex = 0;
    for (const { home, extraEnv } of variants) {
      const variantDir = join(baseDir, `v${reqIndex + 1}`);
      await mkdirAsTestUser(variantDir);
      const W = join(variantDir, "w");
      await buildWorkspaceAsTestUser(W);
      const D = join(variantDir, "d");
      await mkdirAsTestUser(D);
      const S = join(D, "s.jsonl");
      const O = join(D, "results.jsonl");

      const result = await spawnBinAsTestUser({
        args: [
          "run",
          "agent",
          "swe@1",
          "--model",
          `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`,
          "--workspace",
          W,
          "--session",
          S,
          "--output",
          O,
          "--prompt",
          "run task",
        ],
        env: {
          HOME: home,
          TMPDIR: T,
          XDG_STATE_HOME: X,
          PI_CODING_AGENT_DIR: piDirAuth,
          KANTHORD_TOKEN: T1_AC6,
          LANG: "C",
          PATH: process.env.PATH ?? "",
          ...extraEnv,
        },
        signal: t.signal,
        stdin: stdinPayload,
      });
      assert.equal(result.status, SUCCESS_EXIT, result.stderr);

      const req = stub.requests[reqIndex];
      assert.ok(req !== undefined, `no request for variant ${reqIndex + 1}`);
      assert.ok(
        String(req.headers["authorization"] ?? "").includes(TEST_K),
        `variant ${reqIndex + 1}: request does not carry K`,
      );
      const reqText = requestText(req);
      assert.ok(
        !holdsAnyMarker(reqText, AC6_ALL_DECOYS),
        `variant ${reqIndex + 1}: request holds a decoy key`,
      );

      const sfText = await sudoRead(S);
      assert.ok(
        !holdsAnyMarker(sfText, AC6_ALL_DECOYS),
        `variant ${reqIndex + 1}: session file holds a decoy key`,
      );

      reqIndex += 1;
    }
  },
);

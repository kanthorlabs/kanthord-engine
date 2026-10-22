import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { temporary } from "../../kernel/test-support.ts";
import { initialConfig, loadConfig } from "../../config/index.ts";
import { packageVersion } from "../../kernel/version.ts";
import { IdentityKind, CLIENT_IDENTITY_PREFIX } from "../../kernel/caller.ts";
import {
  deriveClientSecret,
  KANTHORD_AUTH_USERNAME,
} from "../../gateway/auth/jwt.ts";
import { decode, verify } from "hono/jwt";
import { identitySchema } from "../../kernel/identity.ts";
import { deriveKey } from "../../kernel/json.ts";
import { parse, stringify } from "yaml";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  writePrivate,
} from "../../kernel/files.ts";
import { clientConfigPath, resolveClient } from "../../gateway/client.ts";

import { ExitCode } from "./constants.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { instanceConfigurationValue } from "../../worker/contract.ts";
import { INSTANCE_CONFIG_VARIABLE } from "../worker/instance-config.ts";
import { runKanthord } from "./test-support.ts";

const EMPTY_OUTPUT = "";
const TOKEN_ROW = "token: ";
const HANDOVER_LOST =
  "cli.worker.handover.indeterminate: worker handover: the result is unknown; retry with a new idempotency key\n";
const MACHINE_TOKEN_ROW = "token: ";
const JWT_OUTPUT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const PROJECT_GET = "get";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PREFIX_BASE_PATH = "/s/kanthord";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SINGLE_DIAGNOSTIC_LINE = 1;
const DATA_DIRECTORY = "data";
const WORKER_UNREACHABLE_ENDPOINT = "http://127.0.0.1:1";
const WORKER_UNREACHABLE_ARGS = [
  "serve",
  "worker",
  "--instance",
  "laptop",
  "--endpoint",
  WORKER_UNREACHABLE_ENDPOINT,
];
const TOKEN_LIFETIME_SECONDS = 600;
const CONTAINER_INIT_HINT =
  "container: podman run --rm -v <volume>:/var/lib/kanthord docker.io/kanthorlabs/kanthord:<version> config init --gateway-bind :: --gateway-allowed-host localhost:<port> --gateway-allowed-host 127.0.0.1:<port>\n";
const entry = new URL("../../main.ts", import.meta.url).href;
const execFileAsync = promisify(execFile);
async function invocation(
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  terminal = false,
) {
  const { code, stdout, stderr } = await runKanthord(
    args,
    env,
    signal,
    terminal,
  );
  return { status: code, stdout, stderr };
}
function environment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KANTHORD_CONFIG: join(directory, "kanthord.yaml"),
    XDG_CONFIG_HOME: directory,
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
    KANTHORD_ENDPOINT: undefined,
    KANTHORD_TOKEN: undefined,
  };
}

test("CLI help works offline, config help resolves its path, and unsupported names/options fail", async (t) => {
  const env = environment(temporary(t));
  const help = await invocation(["--help"], env, t.signal);
  assert.equal(help.status, ExitCode.Success);
  for (const name of [
    "config",
    "serve",
    "auth",
    "gateway",
    "project",
    "mission",
    "scheduler",
    "worker",
    "tracking",
  ])
    assert.ok(help.stdout.includes(name));
  assert.notEqual(
    (await invocation([], env, t.signal)).status,
    ExitCode.Success,
  );
  assert.notEqual(
    (await invocation(["unknown"], env, t.signal)).status,
    ExitCode.Success,
  );
  const unsupported = await invocation(["serve", "unknown"], env, t.signal);
  assert.notEqual(unsupported.status, ExitCode.Success);
  assert.match(unsupported.stderr, /^cli\.serve\.unsupported_application:/);
  assert.notEqual(
    (await invocation(["gateway", "--config", "other.yaml"], env, t.signal))
      .status,
    ExitCode.Success,
  );
  for (const args of [
    ["config", "--help"],
    ["config", "init", "--help"],
    ["config", "validate", "--help"],
    ["config", "show", "--help"],
  ]) {
    const result = await invocation(args, env, t.signal);
    assert.equal(result.status, ExitCode.Success);
    assert.ok(result.stdout.includes(env.KANTHORD_CONFIG!));
  }
  const option = await invocation(
    ["config", "show", "--config", "relative.yaml", "--help"],
    env,
    t.signal,
  );
  assert.equal(option.status, ExitCode.Success);
  assert.ok(option.stdout.includes(join(process.cwd(), "relative.yaml")));
  assert.equal(
    (await invocation(["gateway", "--help"], env, t.signal)).status,
    ExitCode.Success,
  );
  assert.equal(
    (await invocation(["worker", "--help"], env, t.signal)).status,
    ExitCode.Success,
  );
});

test("project commands expose offline help and validate inputs before I/O", async (t) => {
  const env = environment(temporary(t));
  const group = await invocation(["project", "--help"], env, t.signal);
  assert.equal(group.status, ExitCode.Success, group.stderr);
  for (const leaf of ["create", "list", "get", "rename"]) {
    assert.match(group.stdout, new RegExp(`\\b${leaf}\\b`));
    const help = await invocation(["project", leaf, "--help"], env, t.signal);
    assert.equal(help.status, ExitCode.Success, help.stderr);
  }
  for (const [args, code] of [
    [["create", "--name", "Invalid"], "cli.project.create.invalid_name"],
    [["list", "--limit", "0"], "cli.pagination.limit_invalid"],
    [["list", "--limit", "1001"], "cli.pagination.limit_out_of_range"],
    [["get", "invalid"], "cli.project.get.invalid_project_id"],
    [
      ["rename", "invalid", "--name", "Invalid"],
      "cli.project.rename.invalid_project_id",
    ],
    [
      ["rename", "project_01ARZ3NDEKTSV4RRFFQ69G5FAV", "--name", "Invalid"],
      "cli.project.rename.invalid_name",
    ],
    [["create", "--name", "valid"], "cli.project.create.token_required"],
    [["list"], "cli.project.list.token_required"],
    [
      ["get", "project_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      "cli.project.get.token_required",
    ],
    [
      ["rename", "project_01ARZ3NDEKTSV4RRFFQ69G5FAV", "--name", "valid"],
      "cli.project.rename.token_required",
    ],
  ] as const) {
    const result = await invocation(["project", ...args], env, t.signal);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, new RegExp(`^${code.replaceAll(".", "\\.")}:`));
    assert.equal(result.stdout, EMPTY_OUTPUT);
  }
  for (const leaf of ["list", "get"]) {
    const args =
      leaf === PROJECT_GET
        ? ["get", "project_01ARZ3NDEKTSV4RRFFQ69G5FAV"]
        : ["list"];
    const result = await invocation(
      ["project", ...args, "--idempotency-key", "key"],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
});

test("project name diagnostics and help state the name rule", async (t) => {
  const env = environment(temporary(t));
  const rule =
    "a lowercase letter, then lowercase letters, digits or hyphens, at most 63 characters";
  for (const args of [
    ["create", "--name", "Invalid"],
    ["rename", "project_01ARZ3NDEKTSV4RRFFQ69G5FAV", "--name", "Invalid"],
  ]) {
    const result = await invocation(["project", ...args], env, t.signal);
    assert.equal(result.status, ExitCode.Failure);
    assert.ok(result.stderr.includes(rule), result.stderr);
  }
  for (const leaf of ["create", "rename"]) {
    const help = await invocation(["project", leaf, "--help"], env, t.signal);
    assert.ok(help.stdout.replace(/\s+/g, " ").includes(rule), help.stdout);
  }
});

test("a missing token names every token source", async (t) => {
  const result = await invocation(
    ["project", "list"],
    environment(temporary(t)),
    t.signal,
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /^cli\.project\.list\.token_required:/);
  for (const source of [
    "--token",
    "KANTHORD_TOKEN",
    "cli.yaml",
    "kanthord auth jwt generate",
  ])
    assert.ok(result.stderr.includes(source), result.stderr);
});

test("project binding commands expose help and reject invalid inputs before I/O", async (t) => {
  const env = environment(temporary(t));
  const group = await invocation(
    ["project", "binding", "--help"],
    env,
    t.signal,
  );
  assert.equal(group.status, ExitCode.Success, group.stderr);
  for (const leaf of ["list", "get", "export", "apply", "revision"]) {
    assert.match(group.stdout, new RegExp(`\\b${leaf}\\b`));
    assert.equal(
      (await invocation(["project", "binding", leaf, "--help"], env, t.signal))
        .status,
      ExitCode.Success,
    );
  }
  const revision = await invocation(
    ["project", "binding", "revision", "--help"],
    env,
    t.signal,
  );
  assert.equal(revision.status, ExitCode.Success);
  assert.match(revision.stdout, /list/);
  assert.equal(
    (
      await invocation(
        ["project", "binding", "revision", "list", "--help"],
        env,
        t.signal,
      )
    ).status,
    ExitCode.Success,
  );
  for (const [args, code] of [
    [["list", "invalid"], "cli.project.binding.list.invalid_project_id"],
    [
      ["list", PROJECT_ID, "--kind", "unknown"],
      "cli.project.binding.list.invalid_kind",
    ],
    [
      ["list", PROJECT_ID, "--state", "unknown"],
      "cli.project.binding.list.invalid_state",
    ],
    [
      ["list", PROJECT_ID, "--limit", "1001"],
      "cli.pagination.limit_out_of_range",
    ],
    [
      ["get", PROJECT_ID, "invalid"],
      "cli.project.binding.get.invalid_binding_id",
    ],
    [["export", "invalid"], "cli.project.binding.export.invalid_project_id"],
    [
      ["apply", "invalid", "--file", "missing.json"],
      "cli.project.binding.apply.invalid_project_id",
    ],
    [
      ["revision", "list", PROJECT_ID, "invalid"],
      "cli.project.binding.revision.list.invalid_binding_id",
    ],
    [
      ["revision", "list", "invalid", BINDING_ID],
      "cli.project.binding.revision.list.invalid_project_id",
    ],
    [
      ["apply", PROJECT_ID, "--file", "missing.json", "--token", "t"],
      "cli.file.not_found",
    ],
  ] as const) {
    const result = await invocation(
      ["project", "binding", ...args],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure, result.stderr);
    assert.match(result.stderr, new RegExp(`^${code.replaceAll(".", "\\.")}:`));
    assert.equal(result.stdout, EMPTY_OUTPUT);
  }
  for (const args of [
    ["list", PROJECT_ID],
    ["get", PROJECT_ID, BINDING_ID],
    ["export", PROJECT_ID],
    ["apply", PROJECT_ID, "--file", "missing.json"],
    ["revision", "list", PROJECT_ID, BINDING_ID],
  ]) {
    const result = await invocation(
      ["project", "binding", ...args],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /\.token_required:/);
  }
  for (const args of [
    ["list", PROJECT_ID],
    ["get", PROJECT_ID, BINDING_ID],
    ["export", PROJECT_ID],
    ["revision", "list", PROJECT_ID, BINDING_ID],
  ]) {
    const result = await invocation(
      ["project", "binding", ...args, "--idempotency-key", "key"],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
});

test("project agent commands expose help and reject invalid inputs before I/O", async (t) => {
  const env = environment(temporary(t));
  const group = await invocation(["project", "agent", "--help"], env, t.signal);
  assert.equal(group.status, ExitCode.Success, group.stderr);
  for (const leaf of ["list", "get"]) {
    assert.match(group.stdout, new RegExp(`\\b${leaf}\\b`));
    const help = await invocation(
      ["project", "agent", leaf, "--help"],
      env,
      t.signal,
    );
    assert.equal(help.status, ExitCode.Success, help.stderr);
    assert.match(help.stdout, /<worker-binding-id>/);
  }
  for (const [args, code] of [
    [
      ["list", "invalid", BINDING_ID],
      "cli.project.agent.list.invalid_project_id",
    ],
    [
      ["list", PROJECT_ID, "invalid"],
      "cli.project.agent.list.invalid_binding_id",
    ],
    [
      ["list", PROJECT_ID, BINDING_ID, "--limit", "0"],
      "cli.pagination.limit_invalid",
    ],
    [
      ["list", PROJECT_ID, BINDING_ID, "--limit", "1001"],
      "cli.pagination.limit_out_of_range",
    ],
    [
      ["get", "invalid", BINDING_ID, "swe@1"],
      "cli.project.agent.get.invalid_project_id",
    ],
    [
      ["get", PROJECT_ID, "invalid", "swe@1"],
      "cli.project.agent.get.invalid_binding_id",
    ],
    [["list", PROJECT_ID, BINDING_ID], "cli.project.agent.list.token_required"],
    [
      ["get", PROJECT_ID, BINDING_ID, "swe@1"],
      "cli.project.agent.get.token_required",
    ],
  ] as const) {
    const result = await invocation(
      ["project", "agent", ...args],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure, result.stderr);
    assert.match(result.stderr, new RegExp(`^${code.replaceAll(".", "\\.")}:`));
    assert.equal(result.stdout, EMPTY_OUTPUT);
  }
  for (const args of [
    ["list", PROJECT_ID, BINDING_ID],
    ["get", PROJECT_ID, BINDING_ID, "swe@1"],
  ]) {
    const result = await invocation(
      ["project", "agent", ...args, "--idempotency-key", "key"],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
});

test("worker handover validates locally and prints receipt metadata without the envelope", async (t) => {
  const env = environment(temporary(t));
  const help = await invocation(
    ["worker", "handover", "--help"],
    env,
    t.signal,
  );
  assert.equal(help.status, ExitCode.Success);
  assert.match(help.stdout, /<execution-id>/);
  assert.equal(
    (await invocation(["worker", "handover"], env, t.signal)).status,
    ExitCode.Failure,
  );
  const invalid = await invocation(
    ["worker", "handover", "invalid"],
    env,
    t.signal,
  );
  assert.equal(invalid.status, ExitCode.Failure);
  assert.match(invalid.stderr, /^cli\.worker\.handover\.invalid_execution_id:/);
  const executionId = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const args = [
    "worker",
    "handover",
    executionId,
    "--token",
    "machine",
    "--idempotency-key",
    key,
  ];
  const lost = await invocation(
    [...args, "--endpoint", "http://127.0.0.1:1"],
    env,
    t.signal,
  );
  assert.equal(lost.status, ExitCode.Failure);
  assert.equal(lost.stderr, HANDOVER_LOST);
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    globalThis.fetch = async (_url, options) => {
      const assert = (await import('node:assert/strict')).default;
      assert.deepEqual(JSON.parse(options.body), { execution_id: ${JSON.stringify(executionId)} });
      assert.equal(options.headers.get('Idempotency-Key'), ${JSON.stringify(key)});
      return Response.json({ nonce: 'secret-nonce', ciphertext: 'secret-ciphertext' });
    };
    process.argv = [process.execPath, 'kanthord', ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry)});
  `,
    ],
    { env, encoding: "utf8", signal: t.signal },
  );
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.deepEqual(JSON.parse(result.stdout), {
    received: true,
    idempotency_key: key,
  });
  assert.doesNotMatch(result.stdout, /nonce|ciphertext/);
});

test("scheduler execution release tells the operator to read the execution before a retry when the answer is lost", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const file = join(directory, "release.json");
  writeFileSync(file, JSON.stringify({ further_work: false }), {
    mode: 0o600,
  });
  const executionId = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const result = await invocation(
    [
      "scheduler",
      "execution",
      "release",
      executionId,
      "--file",
      file,
      "--endpoint",
      "http://127.0.0.1:1",
      "--token",
      "machine",
      "--idempotency-key",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.match(
    result.stderr,
    /^cli\.scheduler\.execution\.release\.indeterminate:/,
  );
  assert.equal(
    result.stderr,
    `cli.scheduler.execution.release.indeterminate: the result is unknown; read the execution before any retry\ncommand: kanthord scheduler execution get ${executionId}\n`,
  );
});

test("agent enablement commands expose offline help and validate inputs before I/O", async (t) => {
  const env = environment(temporary(t));
  for (const [path, fileRequired] of [
    [["list"], false],
    [["get"], false],
    [["put"], true],
    [["enable"], false],
    [["disable"], false],
    [["remove"], false],
    [["provider", "add"], true],
    [["provider", "remove"], false],
  ] as const) {
    const help = await invocation(
      ["agent", "enablement", ...path, "--help"],
      env,
      t.signal,
    );
    assert.equal(help.status, ExitCode.Success, help.stderr);
    if (fileRequired) assert.match(help.stdout, /--file <path>/);
  }
  assert.equal(
    (await invocation(["worker", "register", "--help"], env, t.signal)).status,
    ExitCode.Success,
  );
  const invalid = await invocation(
    [
      "agent",
      "enablement",
      "enable",
      "swe@1",
      "--endpoint",
      "http://127.0.0.1:1",
      "--token",
      "t",
      "--expected-revision",
      "abc",
    ],
    env,
    t.signal,
  );
  assert.equal(invalid.status, ExitCode.Failure);
  assert.match(
    invalid.stderr,
    /^cli\.agent\.enablement\.enable\.invalid_revision:/,
  );
  const missingToken = await invocation(
    [
      "agent",
      "enablement",
      "put",
      "swe@1",
      "--endpoint",
      "http://127.0.0.1:1",
      "--file",
      "enablement.json",
    ],
    env,
    t.signal,
  );
  assert.equal(missingToken.status, ExitCode.Failure);
  assert.match(
    missingToken.stderr,
    /^cli\.agent\.enablement\.put\.token_required:/,
  );
});

test("agent get and prompt commands expose help and refuse invalid options before I/O", async (t) => {
  const env = environment(temporary(t));
  const remote = ["--endpoint", "http://127.0.0.1:1", "--token", "t"];
  for (const [path, flags] of [
    [
      ["get"],
      /--view <view>[\s\S]*--project <project-id>[\s\S]*--binding-id <binding-id>/,
    ],
    [["prompt", "put"], /--scope <scope>[\s\S]*--file <path>/],
    [["prompt", "switch"], /--switch <source>[\s\S]*--on[\s\S]*--off/],
  ] as const) {
    const help = await invocation(["agent", ...path, "--help"], env, t.signal);
    assert.equal(help.status, ExitCode.Success, help.stderr);
    assert.match(help.stdout, flags);
  }
  for (const [args, code] of [
    [["get", "swe@1", "--view", "full"], "cli.agent.get.invalid_view"],
    [
      ["get", "swe@1", "--project", PROJECT_ID],
      "cli.agent.get.project_binding_pair_required",
    ],
    [
      ["get", "swe@1", "--binding-id", BINDING_ID],
      "cli.agent.get.project_binding_pair_required",
    ],
    [["get", "swe@1", "--view", "final"], "cli.agent.get.token_required"],
    [
      ["prompt", "put", "--scope", "global", "--file", "a.md"],
      "cli.agent.prompt.put.invalid_scope",
    ],
    [
      [
        "prompt",
        "put",
        "--scope",
        "system",
        "--agent",
        "swe@1",
        "--file",
        "a.md",
      ],
      "cli.agent.prompt.put.agent_refused",
    ],
    [
      ["prompt", "put", "--scope", "agent", "--file", "a.md"],
      "cli.agent.prompt.put.agent_required",
    ],
    [
      [
        "prompt",
        "put",
        "--scope",
        "system",
        "--expected-revision",
        "0",
        "--file",
        "a.md",
      ],
      "cli.agent.prompt.put.invalid_revision",
    ],
    [
      ["prompt", "put", "--scope", "system", "--file", "a.md"],
      "cli.agent.prompt.put.token_required",
    ],
    [
      ["prompt", "switch", "--scope", "agent", "--switch", "custom", "--on"],
      "cli.agent.prompt.switch.agent_required",
    ],
    [
      [
        "prompt",
        "switch",
        "--scope",
        "system",
        "--agent",
        "swe@1",
        "--switch",
        "custom",
        "--on",
      ],
      "cli.agent.prompt.switch.agent_refused",
    ],
    [
      [
        "prompt",
        "switch",
        "--scope",
        "system",
        "--switch",
        "agent_file",
        "--on",
      ],
      "cli.agent.prompt.switch.invalid_switch",
    ],
    [
      ["prompt", "switch", "--scope", "system", "--switch", "custom"],
      "cli.agent.prompt.switch.state_required",
    ],
    [
      [
        "prompt",
        "switch",
        "--scope",
        "system",
        "--switch",
        "custom",
        "--on",
        "--off",
      ],
      "cli.agent.prompt.switch.state_required",
    ],
    [
      [
        "prompt",
        "switch",
        "--scope",
        "system",
        "--switch",
        "custom",
        "--on",
        "--expected-revision",
        "x",
      ],
      "cli.agent.prompt.switch.invalid_revision",
    ],
    [
      ["prompt", "switch", "--scope", "system", "--switch", "custom", "--on"],
      "cli.agent.prompt.switch.token_required",
    ],
  ] as const) {
    const withToken = code.endsWith("token_required") ? [] : remote;
    const result = await invocation(
      [
        "agent",
        ...args,
        ...withToken,
        ...(code.endsWith("token_required")
          ? ["--endpoint", "http://127.0.0.1:1"]
          : []),
      ],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure, code);
    assert.equal(result.stdout, EMPTY_OUTPUT, code);
    assert.match(
      result.stderr,
      new RegExp(`^${code.replaceAll(".", "\\.")}:`),
      code,
    );
  }
  const missing = await invocation(
    [
      "agent",
      "prompt",
      "put",
      "--scope",
      "system",
      "--file",
      "absent.md",
      ...remote,
    ],
    env,
    t.signal,
  );
  assert.equal(missing.status, ExitCode.Failure);
  assert.match(missing.stderr, /^cli\.file\.not_found:/);
});

test("serve worker refuses --config and --token and requires an instance configuration before contacting a server", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  env.XDG_STATE_HOME = temporary(t);
  const config = await invocation(
    ["serve", "worker", "--config", "private.yaml"],
    env,
    t.signal,
  );
  assert.equal(config.status, ExitCode.Failure);
  assert.match(config.stderr, /^cli\.serve\.worker_config:/);
  const token = await invocation(
    ["serve", "worker", "--token", "x"],
    env,
    t.signal,
  );
  assert.equal(token.status, ExitCode.Failure);
  assert.match(token.stderr, /^cli\.serve\.worker_token:/);
  const absent = await invocation(WORKER_UNREACHABLE_ARGS, env, t.signal);
  assert.equal(absent.status, ExitCode.Failure);
  assert.equal(absent.stdout, EMPTY_OUTPUT);
  assert.match(absent.stderr, /^worker\.start\.instance_config_absent:/);
  assert.match(absent.stderr, /^variable: +KANTHORD_WORKER_CONFIG$/m);
  assert.ok(
    absent.stderr.includes(
      join(env.XDG_CONFIG_HOME!, "kanthord", "workers", "laptop.yaml"),
    ),
  );
  assert.deepEqual(readdirSync(directory), []);
});

test("serve worker with an instance configuration reports an unavailable server and writes only the pi tools", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  env.XDG_STATE_HOME = temporary(t);
  const pair = await generateX25519KeyPair();
  env[INSTANCE_CONFIG_VARIABLE] = instanceConfigurationValue({
    name: "laptop",
    endpoint: WORKER_UNREACHABLE_ENDPOINT,
    instance_id: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    private_key: pair.private_key.toString("base64url"),
  });
  const unavailable = await invocation(["serve", "worker"], env, t.signal);
  assert.equal(unavailable.status, ExitCode.Failure);
  assert.equal(unavailable.stdout, EMPTY_OUTPUT);
  assert.equal(
    unavailable.stderr.trim().split("\n").length,
    SINGLE_DIAGNOSTIC_LINE,
  );
  assert.match(unavailable.stderr, /^worker\.version\.unavailable:/);
  assert.deepEqual(readdirSync(directory), [DATA_DIRECTORY]);
});

test("--version prints the package version and exits without work", async (t) => {
  const env = environment(temporary(t));
  for (const flag of ["--version", "-V"]) {
    const result = await invocation([flag], env, t.signal);
    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.equal(result.stdout, `${packageVersion()}\n`);
  }
  assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
});

test("config init is non-interactive, writes validated private configuration without displaying secrets and preserves existing files", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const accepted = await invocation(["config", "init"], env, t.signal);
  assert.equal(accepted.status, ExitCode.Success, accepted.stderr);
  const content = readFileSync(env.KANTHORD_CONFIG!, "utf8");
  assert.equal(accepted.stdout, `created: ${env.KANTHORD_CONFIG!}\n`);
  assert.ok(
    !accepted.stdout.includes(loadConfig(env.KANTHORD_CONFIG!).master_key),
  );
  assert.equal(statSync(env.KANTHORD_CONFIG!).mode & 0o777, PRIVATE_FILE_MODE);
  const existing = await invocation(["config", "init"], env, t.signal);
  assert.notEqual(existing.status, ExitCode.Success);
  assert.equal(readFileSync(env.KANTHORD_CONFIG!, "utf8"), content);
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
});

test("config init appends each lowercased allowed host to the default host allowlist", async (t) => {
  const env = environment(temporary(t));
  const result = await invocation(
    [
      "config",
      "init",
      "--gateway-allowed-host",
      "Mac.Tailnet.ts.net",
      "--gateway-allowed-host",
      "localhost:31415",
      "--gateway-allowed-host",
      "203.0.113.7:8443",
    ],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.deepEqual(loadConfig(env.KANTHORD_CONFIG!).gateway.allowed_hosts, [
    "127.0.0.1:31415",
    "localhost:31415",
    "mac.tailnet.ts.net",
    "203.0.113.7:8443",
  ]);
});

test("config init sets the gateway bind address", async (t) => {
  for (const address of ["0.0.0.0", "::", "127.0.0.1"]) {
    const env = environment(temporary(t));
    const result = await invocation(
      ["config", "init", "--gateway-bind", address],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.equal(loadConfig(env.KANTHORD_CONFIG!).gateway.bind, address);
  }
});

test("config init refuses a bind value that is not an IP address and writes nothing", async (t) => {
  const env = environment(temporary(t));
  for (const value of ["localhost", "0.0.0.0:31415", ""]) {
    const result = await invocation(
      ["config", "init", "--gateway-bind", value],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^system\.config\.invalid_field:/);
    assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  }
});

test("config init sets the gateway base path", async (t) => {
  const env = environment(temporary(t));
  const result = await invocation(
    ["config", "init", "--gateway-base-path", PREFIX_BASE_PATH],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(
    loadConfig(env.KANTHORD_CONFIG!).gateway.base_path,
    PREFIX_BASE_PATH,
  );
});

test("config init refuses an invalid base path and writes nothing", async (t) => {
  const env = environment(temporary(t));
  for (const value of ["s/kanthord", "/s/kanthord/", "//", ""]) {
    const result = await invocation(
      ["config", "init", "--gateway-base-path", value],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^system\.config\.invalid_field:/);
    assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  }
});

test("config init refuses an allowed host that is not a name with an optional port and writes nothing", async (t) => {
  const env = environment(temporary(t));
  for (const value of [
    "https://mac.tailnet.ts.net",
    "mac.tailnet.ts.net/path",
    "user@mac.tailnet.ts.net",
    "mac tailnet",
    "",
  ]) {
    const result = await invocation(
      ["config", "init", "--gateway-allowed-host", value],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^cli\.config\.invalid_allowed_host:/);
    assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  }
});

test("removed authentication commands and excess arguments fail without prompting or creating files", async (t) => {
  const env = environment(temporary(t));
  const help = await invocation(["gateway", "--help"], env, t.signal);
  assert.equal(help.status, ExitCode.Success);
  assert.doesNotMatch(help.stdout, /login|logout|\bjwt\b/);
  for (const args of [
    ["jwt"],
    ["jwt", "generate"],
    ["gateway", "jwt"],
    ["gateway", "logout"],
    ["gateway", "register"],
    ["gateway", "login"],
    ["gateway", "login", "--token", ""],
    ["gateway", "login", "--token", " "],
    ["gateway", "login", "--username", KANTHORD_AUTH_USERNAME],
    ["gateway", "login", "--password", "secret-marker"],
    ["gateway", "login", "--username", "", "--password", "secret-marker"],
    [
      "gateway",
      "login",
      "--username",
      KANTHORD_AUTH_USERNAME,
      "--password",
      "secret-marker".repeat(30),
    ],
    ["config", "init", "extra"],
    ["gateway", "logout", "extra"],
  ]) {
    const result = await invocation(args, env, t.signal);
    assert.notEqual(result.status, ExitCode.Success);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /secret-marker|Username:|Password:|\[y\/N\]/,
    );
  }
  assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  assert.equal(existsSync(clientConfigPath(env)), false);
});

test("an unknown operand names the unknown command and suggests a similar one", async (t) => {
  const env = environment(temporary(t));
  for (const [args, suggestion] of [
    [["projec"], /Did you mean project\?/],
    [["project", "lst"], /Did you mean list\?/],
    [["projet", "list", "--token", "x"], /Did you mean project\?/],
    [["project", "lst", "--limit", "5"], /Did you mean list\?/],
    [["jwt"], /^error: unknown command 'jwt'/],
    [["project", "binding", "nope"], /^error: unknown command 'nope'/],
  ] as const) {
    const result = await invocation([...args], env, t.signal);
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /error: unknown command/);
    assert.match(result.stderr, suggestion);
  }
  for (const args of [
    ["project", "--bogus"],
    ["--bogus", "project"],
  ]) {
    const result = await invocation(args, env, t.signal);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /error: unknown option '--bogus'/);
  }
  const group = await invocation(["project"], env, t.signal);
  assert.equal(group.status, ExitCode.Success);
  assert.match(group.stdout, /^Usage: kanthord project/);
  const bare = await invocation([], env, t.signal);
  assert.equal(bare.status, ExitCode.Failure);
  assert.match(bare.stdout, /^Usage: kanthord/);
});

test("validate/show and serve never create or repair configuration and never disclose invalid values", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  for (const args of [["config", "validate"], ["serve"], ["serve", "server"]]) {
    const result = await invocation(args, env, t.signal);
    assert.notEqual(result.status, ExitCode.Success);
    assert.ok(result.stderr.includes(env.KANTHORD_CONFIG!));
    assert.match(result.stderr, /^system\.config\.not_found:/);
    assert.ok(result.stderr.includes(CONTAINER_INIT_HINT), result.stderr);
    assert.deepEqual(readdirSync(directory), []);
  }
  writePrivate(env.KANTHORD_CONFIG!, "master_key: [secret-marker");
  const invalid = await invocation(["config", "validate"], env, t.signal);
  assert.notEqual(invalid.status, ExitCode.Success);
  assert.doesNotMatch(invalid.stderr + invalid.stdout, /secret-marker/);
  assert.match(invalid.stderr, /^system\.config\.invalid_yaml:/);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig(), true);
  assert.equal(
    (await invocation(["config", "validate"], env, t.signal)).status,
    ExitCode.Success,
  );
  const show = await invocation(["config", "show"], env, t.signal);
  assert.equal(show.status, ExitCode.Success);
  assert.match(show.stdout, /\[Sensitive\]/);
});

test("auth jwt uses its optional username or the constant default, the configured key and lifetime, and terminal-only output", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const config = loadConfig(env.KANTHORD_CONFIG!);
  config.gateway.auth.token_lifetime = TOKEN_LIFETIME_SECONDS;
  writePrivate(env.KANTHORD_CONFIG!, stringify(config), true);
  const redirected = await invocation(
    ["auth", "jwt", "generate"],
    env,
    t.signal,
  );
  assert.equal(redirected.status, ExitCode.Failure);
  assert.equal(redirected.stdout, EMPTY_OUTPUT);
  assert.match(redirected.stderr, /terminal/);
  const help = await invocation(
    ["auth", "jwt", "generate", "--help"],
    env,
    t.signal,
  );
  assert.equal(help.status, ExitCode.Success);
  assert.match(help.stdout, /--config <path>/);
  assert.match(help.stdout, /--output \[path\]/);
  assert.match(help.stdout, /--endpoint <url>/);
  const helpText = help.stdout.replace(/\s+/g, " ");
  assert.ok(helpText.includes(clientConfigPath(env)));
  assert.match(helpText, /creates an absent file only/);
  assert.match(helpText, /readers use only the default path/);
  assert.match(helpText, /Endpoint written to the --output file/);
  assert.match(help.stdout, /Usage: kanthord auth jwt generate .*\[username\]/);
  assert.ok(help.stdout.includes(KANTHORD_AUTH_USERNAME));
  assert.ok(help.stdout.includes(env.KANTHORD_CONFIG!));
  const tokens: string[] = [];
  for (const username of [undefined, "ulrich", "u".repeat(64)]) {
    const result = await invocation(
      [
        "auth",
        "jwt",
        "generate",
        ...(username === undefined ? [] : [username]),
        "--config",
        env.KANTHORD_CONFIG!,
      ],
      { ...env, KANTHORD_CONFIG: join(directory, "absent.yaml") },
      t.signal,
      true,
    );
    assert.equal(result.status, ExitCode.Success, result.stderr);
    const token = result.stdout.slice(TOKEN_ROW.length).trim();
    assert.equal(result.stdout, `${TOKEN_ROW}${token}\n`);
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(deriveKey(config.master_key, "gateway/jwt-hs256/v1")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const claims = await verify(token, key, "HS256");
    assert.equal(claims.sub, username ?? KANTHORD_AUTH_USERNAME);
    assert.equal(claims.kind, IdentityKind.Human);
    assert.equal(claims.name, claims.sub);
    assert.equal(claims.exp! - claims.iat!, TOKEN_LIFETIME_SECONDS);
    assert.equal(claims.ver, undefined);
    tokens.push(token);
  }
  assert.equal(new Set(tokens).size, tokens.length);
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
  for (const args of [[""], [" "], ["u".repeat(65)], ["ulrich", "extra"]]) {
    const invalid = await invocation(
      ["auth", "jwt", "generate", ...args],
      env,
      t.signal,
      true,
    );
    assert.notEqual(invalid.status, ExitCode.Success);
    assert.equal(invalid.stdout, EMPTY_OUTPUT);
  }
});

test("jwt --output creates a private default client file with a verifiable human token on redirected stdout", async (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const config = loadConfig(env.KANTHORD_CONFIG!);
  const result = await invocation(
    ["auth", "jwt", "generate", "--output"],
    env,
    t.signal,
  );
  const path = clientConfigPath(env);
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, `created: ${path}\n`);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.equal(statSync(path).mode & 0o7777, PRIVATE_FILE_MODE);
  assert.equal(statSync(dirname(path)).mode & 0o7777, PRIVATE_DIRECTORY_MODE);
  const document = parse(readFileSync(path, "utf8"));
  assert.deepEqual(document, { token: document.token });
  assert.equal(resolveClient({}, env).token, document.token);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(deriveKey(config.master_key, "gateway/jwt-hs256/v1")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const claims = await verify(document.token, key, "HS256");
  assert.equal(claims.sub, KANTHORD_AUTH_USERNAME);
  assert.equal(claims.kind, IdentityKind.Human);
  assert.ok(!result.stdout.includes(document.token));
  assert.ok(!result.stderr.includes(document.token));
  assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
});

test("jwt --output with --binding writes the machine token without the client secret to a private file and prints neither", async (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const config = loadConfig(env.KANTHORD_CONFIG!);
  const path = join(temporary(t), "worker", "cli.yaml");
  const result = await invocation(
    [
      "auth",
      "jwt",
      "generate",
      "--project",
      PROJECT_ID,
      "--binding",
      "developer",
      "--output",
      path,
      "--endpoint",
      "http://127.0.0.1:31415",
    ],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, `created: ${path}\n`);
  assert.equal(statSync(path).mode & 0o7777, PRIVATE_FILE_MODE);
  const document = parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(document), ["endpoint", "token"]);
  const sub = String(decode(document.token).payload.sub);
  const secret = deriveClientSecret(
    config.master_key,
    config.gateway.auth.version,
    sub,
  );
  assert.ok(!(result.stdout + result.stderr).includes(document.token));
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test("jwt --output resolves an explicit relative export path and writes the endpoint before the token", async (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const path = relative(
    process.cwd(),
    join(env.XDG_CONFIG_HOME!, "ulrich.cli.yaml"),
  );
  const endpoint = "https://tunnel.example";
  const username = "ulrich";
  const result = await invocation(
    [
      "auth",
      "jwt",
      "generate",
      username,
      "--output",
      path,
      "--endpoint",
      endpoint,
    ],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, `created: ${resolve(path)}\n`);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  const content = readFileSync(resolve(path), "utf8");
  const document = parse(content);
  assert.deepEqual(document, { endpoint, token: document.token });
  assert.ok(content.startsWith(`endpoint: ${endpoint}\ntoken: `));
  assert.equal(decode(document.token).payload.sub, username);
  assert.ok(!existsSync(clientConfigPath(env)));
  assert.equal(resolveClient({}, env).token, undefined);
  assert.ok(!result.stdout.includes(document.token));
  assert.ok(!result.stderr.includes(document.token));
  assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
});

test("jwt --output refuses an existing destination without changing its bytes or disclosing a token", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const path = clientConfigPath(env);
  const content =
    "endpoint: https://existing.example\ntoken: keep-this-token\n";
  writePrivate(path, content);
  const before = readdirSync(directory, { recursive: true });
  const result = await invocation(
    ["auth", "jwt", "generate", "--output", "--verbose"],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /^system\.files\.publish_failed:/);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.deepEqual(readFileSync(path), Buffer.from(content));
  assert.deepEqual(readdirSync(directory, { recursive: true }), before);
  assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
  assert.ok(!result.stderr.includes("keep-this-token"));
});

test("jwt --output hints at a second client file only when it has no path", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  writePrivate(clientConfigPath(env), "token: keep-this-token\n");
  const hint = /^hint: pass --output <path> for a second client file$/m;
  const defaulted = await invocation(
    ["auth", "jwt", "generate", "--output"],
    env,
    t.signal,
  );
  assert.match(defaulted.stderr, /^system\.files\.publish_failed:/);
  assert.match(defaulted.stderr, hint);
  const explicit = await invocation(
    ["auth", "jwt", "generate", "--output", clientConfigPath(env)],
    env,
    t.signal,
  );
  assert.match(explicit.stderr, /^system\.files\.publish_failed:/);
  assert.doesNotMatch(explicit.stderr, hint);
});

test("jwt output validation precedes configuration loading and writes no file or token", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const before = readdirSync(directory, { recursive: true });
  const cases: [string[], string][] = [
    [
      ["ulrich", "--output", "--binding", "x", "--endpoint", "ftp://x"],
      "cli.auth.jwt.username_with_binding",
    ],
    [
      [
        "--project",
        PROJECT_ID,
        "--output",
        "--binding",
        "x",
        "--endpoint",
        "ftp://x",
      ],
      "cli.config.invalid_endpoint",
    ],
    [
      ["--project", PROJECT_ID, "--output", "--binding", "x"],
      "system.config.not_found",
    ],
    [
      ["--binding", "x", "--output", "--endpoint", "ftp://x"],
      "cli.auth.jwt.binding_without_project",
    ],
    [
      ["--project", PROJECT_ID, "--output", "--endpoint", "ftp://x"],
      "cli.auth.jwt.project_without_binding",
    ],
    [["--project", "invalid"], "gateway.authentication.invalid_project"],
    ...[" ", "B", "b".repeat(64)].map((binding): [string[], string] => [
      ["--binding", binding],
      "gateway.authentication.invalid_binding",
    ]),
    [["--endpoint", "http://x"], "cli.auth.jwt.endpoint_without_output"],
    [["--endpoint", "ftp://x"], "cli.auth.jwt.endpoint_without_output"],
    ...[
      "ftp://x",
      "relative",
      "https://user@x",
      "https://x?query",
      "https://x#fragment",
    ].map((endpoint): [string[], string] => [
      ["--output", "--endpoint", endpoint],
      "cli.config.invalid_endpoint",
    ]),
    [["--output"], "system.config.not_found"],
  ];
  for (const [options, code] of cases) {
    const result = await invocation(
      ["auth", "jwt", "generate", ...options],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.deepEqual(readdirSync(directory, { recursive: true }), before);
    assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
  }
});

test("jwt --verbose --output prints creation then the existing claim list without the token", async (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const result = await invocation(
    ["auth", "jwt", "generate", "--verbose", "--output"],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  const path = clientConfigPath(env);
  const { token } = parse(readFileSync(path, "utf8"));
  const inspected = await invocation(
    ["auth", "jwt", "inspect", token],
    env,
    t.signal,
  );
  assert.equal(inspected.status, ExitCode.Success, inspected.stderr);
  assert.equal(result.stdout, `created: ${path}\n${inspected.stdout}`);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
});

test("JWT generation requires terminal output before loading configuration in both modes", async (t) => {
  const env = environment(temporary(t));
  for (const options of [
    [],
    ["--project", PROJECT_ID, "--binding", "worker-binding"],
  ]) {
    const result = await invocation(
      ["auth", "jwt", "generate", ...options],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /^cli\.output\.terminal_required:/);
    assert.ok(!existsSync(env.KANTHORD_CONFIG!));
    assert.match(
      result.stderr,
      /pass --output <path>, or run the container command with -t\./,
    );
  }
});

test("jwt accepts display names and issues fresh machine identities without opening a database", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const name = "A display name";
  const binding = "worker-binding";
  const human = await invocation(
    ["auth", "jwt", "generate", "ulrich", "--name", name],
    env,
    t.signal,
    true,
  );
  assert.equal(human.status, ExitCode.Success, human.stderr);
  assert.equal(decode(parse(human.stdout).token).payload.name, name);
  const subjects = new Set<string>();
  const sessions = new Set<string>();
  const ISSUANCES = 2;
  for (let index = 0; index < ISSUANCES; index++) {
    const result = await invocation(
      [
        "auth",
        "jwt",
        "generate",
        "--project",
        PROJECT_ID,
        "--binding",
        binding,
        ...(index ? ["--name", name] : []),
      ],
      env,
      t.signal,
      true,
    );
    assert.equal(result.status, ExitCode.Success, result.stderr);
    const { token } = parse(result.stdout);
    assert.equal(result.stdout, `${MACHINE_TOKEN_ROW}${token}\n`);
    assert.equal(result.stderr, EMPTY_OUTPUT);
    const claims = decode(token).payload;
    assert.equal(claims.kind, IdentityKind.Client);
    assert.equal(claims.project_id, PROJECT_ID);
    assert.equal(claims.resource_identity, `worker:kanthord:${binding}`);
    assert.ok(!("binding" in claims));
    assert.ok(
      identitySchema(CLIENT_IDENTITY_PREFIX).safeParse(claims.sub).success,
    );
    assert.equal(claims.name, index ? name : claims.sub);
    subjects.add(String(claims.sub));
    sessions.add(String(claims.jti));
  }
  assert.equal(subjects.size, ISSUANCES);
  assert.equal(sessions.size, ISSUANCES);
  const conflict = await invocation(
    ["auth", "jwt", "generate", "ulrich", "--binding", binding],
    env,
    t.signal,
    true,
  );
  assert.equal(conflict.status, ExitCode.Failure);
  assert.match(conflict.stderr, /^cli\.auth\.jwt\.username_with_binding:/);
  assert.equal(conflict.stdout, EMPTY_OUTPUT);
  const redirected = await invocation(
    ["auth", "jwt", "generate", "--project", PROJECT_ID, "--binding", binding],
    env,
    t.signal,
  );
  assert.equal(redirected.status, ExitCode.Failure);
  assert.equal(redirected.stdout, EMPTY_OUTPUT);
  assert.match(redirected.stderr, /^cli\.output\.terminal_required:/);
  for (const options of [
    ["--name", " "],
    ["--name", "n".repeat(65)],
    ["--binding", " "],
    ["--binding", "b".repeat(129)],
  ]) {
    const invalid = await invocation(
      ["auth", "jwt", "generate", ...options],
      env,
      t.signal,
      true,
    );
    assert.equal(invalid.status, ExitCode.Failure);
    assert.equal(invalid.stdout, EMPTY_OUTPUT);
  }
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
});

test("auth jwt group, verbose generation, inspection and token precedence", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const auth = await invocation(["auth"], env, t.signal);
  assert.equal(auth.status, ExitCode.Success);
  assert.match(auth.stdout, /\bjwt\b/);
  const group = await invocation(["auth", "jwt"], env, t.signal);
  assert.equal(group.status, ExitCode.Success);
  assert.match(group.stdout, /generate/);
  assert.match(group.stdout, /inspect/);
  const generated = await invocation(
    ["auth", "jwt", "generate", "ulrich", "--verbose"],
    env,
    t.signal,
    true,
  );
  assert.equal(generated.status, ExitCode.Success, generated.stderr);
  const [tokenLine, ...claimLines] = generated.stdout.split("\n");
  const token = tokenLine!.slice(TOKEN_ROW.length);
  assert.equal(tokenLine, `${TOKEN_ROW}${token}`);
  const claimList = `${claimLines.join("\n")}`;
  const payload = decode(token).payload;
  assert.deepEqual(
    claimLines.slice(1, -2).map((line) => line.split(": ")[0]),
    Object.keys(payload),
  );
  for (const key of ["iat", "exp"]) {
    const seconds = payload[key];
    assert.match(
      claimList,
      new RegExp(
        `${key}: ${seconds} # ${new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z")}`,
      ),
    );
  }
  assert.ok(claimList.startsWith("---\n"));
  assert.ok(claimList.endsWith("---\n"));
  const rootVerbose = await invocation(
    ["--verbose", "auth", "jwt", "generate"],
    env,
    t.signal,
    true,
  );
  assert.equal(rootVerbose.status, ExitCode.Success, rootVerbose.stderr);
  assert.match(rootVerbose.stdout, /^token: \S+\n---\n/);
  const plain = await invocation(
    ["auth", "jwt", "generate"],
    env,
    t.signal,
    true,
  );
  assert.equal(plain.status, ExitCode.Success, plain.stderr);
  assert.match(plain.stdout, /^token: \S+\n$/);
  const inspect = await invocation(
    ["auth", "jwt", "inspect", token],
    env,
    t.signal,
  );
  assert.equal(inspect.status, ExitCode.Success, inspect.stderr);
  assert.equal(inspect.stdout, claimList);
  const machine = await invocation(
    [
      "auth",
      "jwt",
      "generate",
      "--project",
      PROJECT_ID,
      "--binding",
      "worker-binding",
      "--verbose",
    ],
    env,
    t.signal,
    true,
  );
  assert.equal(machine.status, ExitCode.Success, machine.stderr);
  const [machineTokenLine, ...machineClaims] = machine.stdout.split("\n");
  const machineToken = machineTokenLine!.slice(MACHINE_TOKEN_ROW.length);
  assert.equal(machineTokenLine, `${MACHINE_TOKEN_ROW}${machineToken}`);
  assert.doesNotMatch(machine.stdout, /client_secret/);
  const machineInspect = await invocation(
    ["auth", "jwt", "inspect", machineToken],
    env,
    t.signal,
  );
  assert.equal(machineInspect.status, ExitCode.Success, machineInspect.stderr);
  assert.equal(machineClaims.join("\n"), machineInspect.stdout);
  assert.match(machineInspect.stdout, new RegExp(`project_id: ${PROJECT_ID}`));
  assert.match(
    machineInspect.stdout,
    /resource_identity: worker:kanthord:worker-binding/,
  );
  assert.doesNotMatch(machineInspect.stdout, /^binding:/m);
  assert.equal(machine.stderr, EMPTY_OUTPUT);
  const other = plain.stdout.slice(TOKEN_ROW.length).trim();
  writePrivate(clientConfigPath(env), `token: ${other}\n`);
  assert.equal(
    (await invocation(["auth", "jwt", "inspect"], env, t.signal)).stdout,
    (await invocation(["auth", "jwt", "inspect", other], env, t.signal)).stdout,
  );
  assert.equal(
    (
      await invocation(
        ["auth", "jwt", "inspect"],
        {
          ...env,
          KANTHORD_TOKEN: token,
        },
        t.signal,
      )
    ).stdout,
    claimList,
  );
  assert.equal(
    (
      await invocation(
        ["auth", "jwt", "inspect", other],
        {
          ...env,
          KANTHORD_TOKEN: token,
        },
        t.signal,
      )
    ).stdout,
    (await invocation(["auth", "jwt", "inspect", other], env, t.signal)).stdout,
  );
  const absent = await invocation(
    ["auth", "jwt", "inspect"],
    environment(temporary(t)),
    t.signal,
  );
  assert.equal(absent.status, ExitCode.Failure);
  assert.match(absent.stderr, /^cli\.auth\.jwt\.inspect\.token_required:/);
  for (const invalid of [
    "not-a-jwt",
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from("[]").toString("base64url")}.sig`,
  ]) {
    const result = await invocation(
      ["auth", "jwt", "inspect", invalid],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^cli\.auth\.jwt\.inspect\.malformed_token:/);
    assert.ok(!result.stderr.includes(invalid));
  }
  assert.notEqual(
    (
      await invocation(
        ["auth", "jwt", "inspect", "--config", "x"],
        env,
        t.signal,
      )
    ).status,
    ExitCode.Success,
  );
  const baseline = await invocation(["config", "validate"], env, t.signal);
  const verbose = await invocation(
    ["config", "validate", "--verbose"],
    env,
    t.signal,
  );
  assert.equal(verbose.stdout, baseline.stdout);
  assert.equal(verbose.status, baseline.status);
});

test("launcher rejects an unsupported runtime before importing application code", async () => {
  const launcher = new URL("../../../bin/kanthord.mjs", import.meta.url).href;
  for (const version of ["22.0.0", "24.14.9", "25.0.0"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});await import(${JSON.stringify(launcher)});`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.equal(
      result.stderr.trim().split("\n").length,
      SINGLE_DIAGNOSTIC_LINE,
    );
    assert.match(result.stderr, />=24.15.0 <25/);
  }
});

test("intake outbound commands expose offline help, reject --config and validate identities before I/O", async (t) => {
  const env = environment(temporary(t));
  const outboundId = "outbound_request_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  for (const args of [
    ["intake", "--help"],
    ["intake", "outbound", "--help"],
    ["intake", "outbound", "list", "--help"],
    ["intake", "outbound", "get", "--help"],
    ["intake", "outbound", "discard", "--help"],
    ["intake", "outbound", "delete", "--help"],
  ]) {
    const help = await invocation(args, env, t.signal);
    assert.equal(help.status, ExitCode.Success, help.stderr);
  }
  for (const leaf of [
    ["list"],
    ["get", outboundId],
    ["discard", outboundId],
    ["delete"],
  ]) {
    const result = await invocation(
      ["intake", "outbound", ...leaf, "--config", "x.yaml"],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
  const invalid = await invocation(
    ["intake", "outbound", "get", "bad"],
    env,
    t.signal,
  );
  assert.equal(invalid.status, ExitCode.Failure);
  assert.match(
    invalid.stderr,
    /^cli\.intake\.outbound\.get\.invalid_outbound_request_id:/,
  );
  const discard = await invocation(
    ["intake", "outbound", "discard", "bad"],
    env,
    t.signal,
  );
  assert.match(
    discard.stderr,
    /^cli\.intake\.outbound\.discard\.invalid_outbound_request_id:/,
  );
  const repeated = await invocation(
    ["intake", "outbound", "list", "--state", "failed", "--state", "failed"],
    env,
    t.signal,
  );
  assert.match(repeated.stderr, /^cli\.option\.duplicate:/);
  const outOfRange = await invocation(
    [
      "intake",
      "outbound",
      "list",
      "--limit",
      "1001",
      "--endpoint",
      "http://127.0.0.1:1",
      "--token",
      "t",
    ],
    env,
    t.signal,
  );
  assert.equal(outOfRange.status, ExitCode.Failure);
  assert.match(outOfRange.stderr, /^cli\.pagination\.limit_out_of_range:/);
});

test("intake inbound commands expose offline help, reject --config and validate identities before I/O", async (t) => {
  const env = environment(temporary(t));
  const inboundId = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  for (const args of [
    ["intake", "inbound", "--help"],
    ["intake", "inbound", "create", "--help"],
    ["intake", "inbound", "list", "--help"],
    ["intake", "inbound", "get", "--help"],
    ["intake", "inbound", "delete", "--help"],
  ]) {
    const help = await invocation(args, env, t.signal);
    assert.equal(help.status, ExitCode.Success, help.stderr);
  }
  for (const leaf of [
    ["create", "--file", "x.json"],
    ["list"],
    ["get", inboundId],
    ["delete", inboundId],
  ]) {
    const result = await invocation(
      ["intake", "inbound", ...leaf, "--config", "x.yaml"],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
  const get = await invocation(
    ["intake", "inbound", "get", "bad"],
    env,
    t.signal,
  );
  assert.equal(get.status, ExitCode.Failure);
  assert.match(get.stderr, /^cli\.intake\.inbound\.get\.invalid_inbound_id:/);
  const remove = await invocation(
    ["intake", "inbound", "delete", "bad"],
    env,
    t.signal,
  );
  assert.match(
    remove.stderr,
    /^cli\.intake\.inbound\.delete\.invalid_inbound_id:/,
  );
  const create = await invocation(
    ["intake", "inbound", "create"],
    env,
    t.signal,
  );
  assert.equal(create.status, ExitCode.Failure);
  assert.match(create.stderr, /--file/);
  const outOfRange = await invocation(
    [
      "intake",
      "inbound",
      "list",
      "--limit",
      "1001",
      "--endpoint",
      "http://127.0.0.1:1",
      "--token",
      "t",
    ],
    env,
    t.signal,
  );
  assert.equal(outOfRange.status, ExitCode.Failure);
  assert.match(outOfRange.stderr, /^cli\.pagination\.limit_out_of_range:/);
});

test("intake event commands expose offline help, reject --config and validate before I/O", async (t) => {
  const env = environment(temporary(t));
  const eventId = "inbound_event_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  for (const args of [
    ["intake", "event", "--help"],
    ["intake", "event", "list", "--help"],
    ["intake", "event", "get", "--help"],
    ["intake", "event", "retry", "--help"],
    ["intake", "event", "discard", "--help"],
    ["intake", "event", "delete", "--help"],
  ]) {
    const help = await invocation(args, env, t.signal);
    assert.equal(help.status, ExitCode.Success, help.stderr);
  }
  for (const leaf of [
    ["list"],
    ["get", eventId],
    ["retry", eventId],
    ["discard", eventId],
    ["delete", "--id", eventId],
  ]) {
    const result = await invocation(
      ["intake", "event", ...leaf, "--config", "x.yaml"],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
  const get = await invocation(
    ["intake", "event", "get", "bad"],
    env,
    t.signal,
  );
  assert.equal(get.status, ExitCode.Failure);
  assert.match(
    get.stderr,
    /^cli\.intake\.event\.get\.invalid_inbound_event_id:/,
  );
  for (const leaf of ["retry", "discard"]) {
    const bad = await invocation(
      ["intake", "event", leaf, "bad"],
      env,
      t.signal,
    );
    assert.equal(bad.status, ExitCode.Failure);
    assert.match(
      bad.stderr,
      new RegExp(`^cli\\.intake\\.event\\.${leaf}\\.invalid_inbound_event_id:`),
    );
  }
  for (const leaf of [["retry", eventId], ["discard", eventId], ["delete"]]) {
    const result = await invocation(
      ["intake", "event", ...leaf],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(
      result.stderr,
      new RegExp(`^cli\\.intake\\.event\\.${leaf[0]}\\.token_required:`),
    );
  }
  const outOfRange = await invocation(
    [
      "intake",
      "event",
      "list",
      "--limit",
      "1001",
      "--endpoint",
      "http://127.0.0.1:1",
      "--token",
      "t",
    ],
    env,
    t.signal,
  );
  assert.equal(outOfRange.status, ExitCode.Failure);
  assert.match(outOfRange.stderr, /^cli\.pagination\.limit_out_of_range:/);
});

test("intake outbound discard prints the generated key when the result is indeterminate", async (t) => {
  const env = environment(temporary(t));
  const args = [
    "intake",
    "outbound",
    "discard",
    "outbound_request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "--endpoint",
    "http://127.0.0.1:1",
    "--token",
    "t",
  ];
  const result = await invocation(args, env, t.signal);
  assert.equal(result.status, ExitCode.Failure);
  assert.match(
    result.stderr,
    /^cli\.intake\.outbound\.discard\.indeterminate:/,
  );
  assert.match(result.stderr, /^idempotency_key: [0-9A-HJKMNP-TV-Z]{26}$/m);
});

test("intake event mutations print the generated key when the result is indeterminate", async (t) => {
  const env = environment(temporary(t));
  const eventId = "inbound_event_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const server = ["--endpoint", "http://127.0.0.1:1", "--token", "t"];
  for (const leaf of [
    ["retry", eventId],
    ["discard", eventId],
    ["delete", "--id", eventId],
  ]) {
    const result = await invocation(
      ["intake", "event", ...leaf, ...server],
      env,
      t.signal,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(
      result.stderr,
      new RegExp(`^cli\\.intake\\.event\\.${leaf[0]}\\.indeterminate:`),
    );
    assert.match(result.stderr, /^idempotency_key: [0-9A-HJKMNP-TV-Z]{26}$/m);
  }
});

const LIVENESS_PATH = "/api/liveness";
const LIVENESS_REQUESTS_PER_RUN = 1;
const LIVENESS_HEALTHY = {
  status: "ok",
  services: { server: { store: 200, log: 200 } },
};
const LIVENESS_UNHEALTHY = {
  error: {
    code: "gateway.liveness.unhealthy",
    message: "A service is unavailable.",
    details: { server: { store: 503, log: 200 } },
  },
  request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

async function livenessServer(
  t: TestContext,
  status: number,
  body: unknown,
  headers: IncomingHttpHeaders[],
  path = LIVENESS_PATH,
): Promise<string> {
  const server = createServer((request, response) => {
    assert.equal(request.url, path);
    headers.push(request.headers);
    request.resume();
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("gateway liveness prints the answer and exits 0 on 200", async (t) => {
  const env = environment(temporary(t));
  const headers: IncomingHttpHeaders[] = [];
  const endpoint = await livenessServer(t, 200, LIVENESS_HEALTHY, headers);
  const result = await invocation(
    ["gateway", "liveness", "--endpoint", endpoint],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.equal(result.stdout, `${JSON.stringify(LIVENESS_HEALTHY)}\n`);
  assert.equal(headers.length, LIVENESS_REQUESTS_PER_RUN);
});

test("gateway liveness exits 1 on 503 and prints the code and details", async (t) => {
  const env = environment(temporary(t));
  const headers: IncomingHttpHeaders[] = [];
  const endpoint = await livenessServer(t, 503, LIVENESS_UNHEALTHY, headers);
  const result = await invocation(
    ["gateway", "--endpoint", endpoint, "liveness"],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.equal(
    result.stderr,
    `gateway.liveness.unhealthy: gateway liveness: request failed\nstatus:  503\ndetails: ${JSON.stringify(LIVENESS_UNHEALTHY.error.details)}\n`,
  );
});

test("gateway liveness exits 1 with the indeterminate code on a refused connection", async (t) => {
  const env = environment(temporary(t));
  const result = await invocation(
    ["gateway", "liveness", "--endpoint", "http://127.0.0.1:1"],
    env,
    t.signal,
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.match(
    result.stderr,
    /^cli\.gateway\.liveness\.indeterminate: gateway liveness: the result is unknown; retry the command\n/,
  );
});

test("gateway liveness reads no token and sends no Authorization header", async (t) => {
  const directory = temporary(t);
  const headers: IncomingHttpHeaders[] = [];
  const endpoint = await livenessServer(
    t,
    200,
    LIVENESS_HEALTHY,
    headers,
    `${PREFIX_BASE_PATH}${LIVENESS_PATH}`,
  );
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: `${endpoint}${PREFIX_BASE_PATH}`,
    KANTHORD_TOKEN: "secret-marker",
  };
  writePrivate(clientConfigPath(env), stringify({ token: "secret-marker" }));
  const result = await invocation(["gateway", "liveness"], env, t.signal);
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(headers.length, LIVENESS_REQUESTS_PER_RUN);
  assert.equal(headers[0]!.authorization, undefined);
  const rejected = await invocation(
    ["gateway", "liveness", "--endpoint", endpoint, "--token", "x"],
    env,
    t.signal,
  );
  assert.equal(rejected.status, ExitCode.Failure);
  assert.equal(headers.length, LIVENESS_REQUESTS_PER_RUN);
});

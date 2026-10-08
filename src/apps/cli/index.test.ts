import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
} from "../../gateway/local.ts";
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

const EMPTY_OUTPUT = "";
const JWT_OUTPUT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const PROJECT_GET = "get";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SINGLE_DIAGNOSTIC_LINE = 1;
const CLIENT_SECRET_BYTES = 32;
const WORKER_UNREACHABLE_ARGS = [
  "serve",
  "worker",
  "--endpoint",
  "http://127.0.0.1:1",
  "--token",
  "x",
];
const CLIENT_CONFIG_ENTRIES = ["kanthord", join("kanthord", "cli.yaml")];
const TOKEN_LIFETIME_SECONDS = 600;
const entry = new URL("../../main.ts", import.meta.url).href;
function invocation(args: string[], env: NodeJS.ProcessEnv, terminal = false) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${terminal ? "process.stdout.isTTY=true;" : ""}process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
    ],
    { encoding: "utf8", env, timeout: 10000 },
  );
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

test("CLI help works offline, config help resolves its path, and unsupported names/options fail", (t) => {
  const env = environment(temporary(t));
  const help = invocation(["--help"], env);
  assert.equal(help.status, ExitCode.Success);
  for (const name of [
    "config",
    "serve",
    "jwt",
    "gateway",
    "project",
    "mission",
    "scheduler",
    "worker",
    "tracking",
  ])
    assert.ok(help.stdout.includes(name));
  assert.notEqual(invocation([], env).status, ExitCode.Success);
  assert.notEqual(invocation(["unknown"], env).status, ExitCode.Success);
  const unsupported = invocation(["serve", "unknown"], env);
  assert.notEqual(unsupported.status, ExitCode.Success);
  assert.match(unsupported.stderr, /^cli\.serve\.unsupported_application:/);
  assert.notEqual(
    invocation(["gateway", "--config", "other.yaml"], env).status,
    ExitCode.Success,
  );
  for (const args of [
    ["config", "--help"],
    ["config", "init", "--help"],
    ["config", "validate", "--help"],
    ["config", "show", "--help"],
  ]) {
    const result = invocation(args, env);
    assert.equal(result.status, ExitCode.Success);
    assert.ok(result.stdout.includes(env.KANTHORD_CONFIG!));
  }
  const option = invocation(
    ["config", "show", "--config", "relative.yaml", "--help"],
    env,
  );
  assert.equal(option.status, ExitCode.Success);
  assert.ok(option.stdout.includes(join(process.cwd(), "relative.yaml")));
  assert.equal(invocation(["gateway", "--help"], env).status, ExitCode.Success);
  assert.equal(invocation(["worker", "--help"], env).status, ExitCode.Success);
});

test("project commands expose offline help and validate inputs before I/O", (t) => {
  const env = environment(temporary(t));
  const group = invocation(["project", "--help"], env);
  assert.equal(group.status, ExitCode.Success, group.stderr);
  for (const leaf of ["create", "list", "get", "rename"]) {
    assert.match(group.stdout, new RegExp(`\\b${leaf}\\b`));
    const help = invocation(["project", leaf, "--help"], env);
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
    const result = invocation(["project", ...args], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, new RegExp(`^${code.replaceAll(".", "\\.")}:`));
    assert.equal(result.stdout, EMPTY_OUTPUT);
  }
  for (const leaf of ["list", "get"]) {
    const args =
      leaf === PROJECT_GET
        ? ["get", "project_01ARZ3NDEKTSV4RRFFQ69G5FAV"]
        : ["list"];
    const result = invocation(
      ["project", ...args, "--idempotency-key", "key"],
      env,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
});

test("project binding commands expose help and reject invalid inputs before I/O", (t) => {
  const env = environment(temporary(t));
  const group = invocation(["project", "binding", "--help"], env);
  assert.equal(group.status, ExitCode.Success, group.stderr);
  for (const leaf of ["list", "get", "export", "apply", "revision"]) {
    assert.match(group.stdout, new RegExp(`\\b${leaf}\\b`));
    assert.equal(
      invocation(["project", "binding", leaf, "--help"], env).status,
      ExitCode.Success,
    );
  }
  const revision = invocation(
    ["project", "binding", "revision", "--help"],
    env,
  );
  assert.equal(revision.status, ExitCode.Success);
  assert.match(revision.stdout, /list/);
  assert.equal(
    invocation(["project", "binding", "revision", "list", "--help"], env)
      .status,
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
    const result = invocation(["project", "binding", ...args], env);
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
    const result = invocation(["project", "binding", ...args], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /\.token_required:/);
  }
  for (const args of [
    ["list", PROJECT_ID],
    ["get", PROJECT_ID, BINDING_ID],
    ["export", PROJECT_ID],
    ["revision", "list", PROJECT_ID, BINDING_ID],
  ]) {
    const result = invocation(
      ["project", "binding", ...args, "--idempotency-key", "key"],
      env,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
});

test("project agent commands expose help and reject invalid inputs before I/O", (t) => {
  const env = environment(temporary(t));
  const group = invocation(["project", "agent", "--help"], env);
  assert.equal(group.status, ExitCode.Success, group.stderr);
  for (const leaf of ["list", "get"]) {
    assert.match(group.stdout, new RegExp(`\\b${leaf}\\b`));
    const help = invocation(["project", "agent", leaf, "--help"], env);
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
    const result = invocation(["project", "agent", ...args], env);
    assert.equal(result.status, ExitCode.Failure, result.stderr);
    assert.match(result.stderr, new RegExp(`^${code.replaceAll(".", "\\.")}:`));
    assert.equal(result.stdout, EMPTY_OUTPUT);
  }
  for (const args of [
    ["list", PROJECT_ID, BINDING_ID],
    ["get", PROJECT_ID, BINDING_ID, "swe@1"],
  ]) {
    const result = invocation(
      ["project", "agent", ...args, "--idempotency-key", "key"],
      env,
    );
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /unknown option/);
  }
});

test("worker handover validates locally and prints receipt metadata without the envelope", (t) => {
  const env = environment(temporary(t));
  const help = invocation(["worker", "handover", "--help"], env);
  assert.equal(help.status, ExitCode.Success);
  assert.match(help.stdout, /<execution-id>/);
  assert.equal(
    invocation(["worker", "handover"], env).status,
    ExitCode.Failure,
  );
  const invalid = invocation(["worker", "handover", "invalid"], env);
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
  const result = spawnSync(
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
    { env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.deepEqual(JSON.parse(result.stdout), {
    received: true,
    idempotency_key: key,
  });
  assert.doesNotMatch(result.stdout, /nonce|ciphertext/);
});

test("scheduler execution release tells the operator to read the execution before a retry when the answer is lost", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const file = join(directory, "release.json");
  writeFileSync(file, JSON.stringify({ further_work: false }), {
    mode: 0o600,
  });
  const executionId = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const result = invocation(
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
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.match(
    result.stderr,
    /^cli\.scheduler\.execution\.release\.indeterminate:/,
  );
  assert.ok(
    result.stderr.includes(`kanthord scheduler execution get ${executionId}`),
    result.stderr,
  );
  assert.doesNotMatch(result.stderr, /retry with --idempotency-key/);
});

test("agent enablement commands expose offline help and validate inputs before I/O", (t) => {
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
    const help = invocation(["agent", "enablement", ...path, "--help"], env);
    assert.equal(help.status, ExitCode.Success, help.stderr);
    if (fileRequired) assert.match(help.stdout, /--file <path>/);
  }
  assert.equal(
    invocation(["worker", "register", "--help"], env).status,
    ExitCode.Success,
  );
  const invalid = invocation(
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
  );
  assert.equal(invalid.status, ExitCode.Failure);
  assert.match(
    invalid.stderr,
    /^cli\.agent\.enablement\.enable\.invalid_revision:/,
  );
  const missingToken = invocation(
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
  );
  assert.equal(missingToken.status, ExitCode.Failure);
  assert.match(
    missingToken.stderr,
    /^cli\.agent\.enablement\.put\.token_required:/,
  );
});

test("agent get and prompt commands expose help and refuse invalid options before I/O", (t) => {
  const env = environment(temporary(t));
  const remote = ["--endpoint", "http://127.0.0.1:1", "--token", "t"];
  for (const [path, flags] of [
    [["get"], /--view <view>[\s\S]*--project <project-id>[\s\S]*--binding/],
    [["prompt", "put"], /--scope <scope>[\s\S]*--file <path>/],
    [["prompt", "switch"], /--switch <source>[\s\S]*--on[\s\S]*--off/],
  ] as const) {
    const help = invocation(["agent", ...path, "--help"], env);
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
      ["get", "swe@1", "--binding", BINDING_ID],
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
    const result = invocation(
      [
        "agent",
        ...args,
        ...withToken,
        ...(code.endsWith("token_required")
          ? ["--endpoint", "http://127.0.0.1:1"]
          : []),
      ],
      env,
    );
    assert.equal(result.status, ExitCode.Failure, code);
    assert.equal(result.stdout, EMPTY_OUTPUT, code);
    assert.match(
      result.stderr,
      new RegExp(`^${code.replaceAll(".", "\\.")}:`),
      code,
    );
  }
  const missing = invocation(
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
  );
  assert.equal(missing.status, ExitCode.Failure);
  assert.match(missing.stderr, /^cli\.file\.not_found:/);
});

test("serve worker rejects server configuration and requires a client_secret before contacting an unavailable server", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const config = invocation(
    ["serve", "worker", "--config", "private.yaml"],
    env,
  );
  assert.equal(config.status, ExitCode.Failure);
  assert.match(config.stderr, /^cli\.serve\.worker_config:/);
  const absent = invocation(WORKER_UNREACHABLE_ARGS, env);
  assert.equal(absent.status, ExitCode.Failure);
  assert.equal(absent.stdout, EMPTY_OUTPUT);
  assert.equal(absent.stderr.trim().split("\n").length, SINGLE_DIAGNOSTIC_LINE);
  assert.match(absent.stderr, /^worker\.start\.client_secret_absent:/);
  assert.deepEqual(readdirSync(directory), []);
});

test("serve worker with a client_secret reports an unavailable server without changing cli.yaml", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const tools = temporary(t);
  for (const name of ["rg", "fd"])
    writeFileSync(join(tools, name), "#!/bin/sh\necho test_tool\n", {
      mode: 0o700,
    });
  env.PATH = `${tools}:${process.env.PATH ?? ""}`;
  const path = clientConfigPath(env);
  const content = stringify({
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
  });
  writePrivate(path, content);
  const filesBefore = readdirSync(directory, { recursive: true });
  assert.deepEqual(filesBefore, CLIENT_CONFIG_ENTRIES);
  const unavailable = invocation(WORKER_UNREACHABLE_ARGS, env);
  assert.equal(unavailable.status, ExitCode.Failure);
  assert.equal(unavailable.stdout, EMPTY_OUTPUT);
  assert.equal(
    unavailable.stderr.trim().split("\n").length,
    SINGLE_DIAGNOSTIC_LINE,
  );
  assert.match(unavailable.stderr, /^worker\.version\.unavailable:/);
  assert.deepEqual(readdirSync(directory, { recursive: true }), filesBefore);
  assert.equal(readFileSync(path, "utf8"), content);
});

test("--version prints the package version and exits without work", (t) => {
  const env = environment(temporary(t));
  for (const flag of ["--version", "-V"]) {
    const result = invocation([flag], env);
    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.equal(result.stdout, `${packageVersion()}\n`);
  }
  assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
});

test("config init is non-interactive, writes validated private configuration without displaying secrets and preserves existing files", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const accepted = invocation(["config", "init"], env);
  assert.equal(accepted.status, ExitCode.Success, accepted.stderr);
  const content = readFileSync(env.KANTHORD_CONFIG!, "utf8");
  assert.equal(accepted.stdout, `Created ${env.KANTHORD_CONFIG!}\n`);
  assert.ok(
    !accepted.stdout.includes(loadConfig(env.KANTHORD_CONFIG!).master_key),
  );
  assert.equal(statSync(env.KANTHORD_CONFIG!).mode & 0o777, PRIVATE_FILE_MODE);
  const existing = invocation(["config", "init"], env);
  assert.notEqual(existing.status, ExitCode.Success);
  assert.equal(readFileSync(env.KANTHORD_CONFIG!, "utf8"), content);
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
});

test("config init appends each lowercased allowed host to the default host allowlist", (t) => {
  const env = environment(temporary(t));
  const result = invocation(
    [
      "config",
      "init",
      "--allowed-host",
      "Mac.Tailnet.ts.net",
      "--allowed-host",
      "localhost:31415",
      "--allowed-host",
      "203.0.113.7:8443",
    ],
    env,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.deepEqual(loadConfig(env.KANTHORD_CONFIG!).gateway.allowed_hosts, [
    "127.0.0.1:31415",
    "localhost:31415",
    "mac.tailnet.ts.net",
    "203.0.113.7:8443",
  ]);
});

test("config init sets the gateway bind address", (t) => {
  for (const address of ["0.0.0.0", "::", "127.0.0.1"]) {
    const env = environment(temporary(t));
    const result = invocation(["config", "init", "--bind", address], env);
    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.equal(loadConfig(env.KANTHORD_CONFIG!).gateway.bind, address);
  }
});

test("config init refuses a bind value that is not an IP address and writes nothing", (t) => {
  const env = environment(temporary(t));
  for (const value of ["localhost", "0.0.0.0:31415", ""]) {
    const result = invocation(["config", "init", "--bind", value], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^system\.config\.invalid_field:/);
    assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  }
});

test("config init refuses an allowed host that is not a name with an optional port and writes nothing", (t) => {
  const env = environment(temporary(t));
  for (const value of [
    "https://mac.tailnet.ts.net",
    "mac.tailnet.ts.net/path",
    "user@mac.tailnet.ts.net",
    "mac tailnet",
    "",
  ]) {
    const result = invocation(["config", "init", "--allowed-host", value], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^cli\.config\.invalid_allowed_host:/);
    assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  }
});

test("removed authentication commands and excess arguments fail without prompting or creating files", (t) => {
  const env = environment(temporary(t));
  const help = invocation(["gateway", "--help"], env);
  assert.equal(help.status, ExitCode.Success);
  assert.doesNotMatch(help.stdout, /login|logout|\bjwt\b/);
  for (const args of [
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
    const result = invocation(args, env);
    assert.notEqual(result.status, ExitCode.Success);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /secret-marker|Username:|Password:|\[y\/N\]/,
    );
  }
  assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
  assert.equal(existsSync(clientConfigPath(env)), false);
});

test("validate/show and serve never create or repair configuration and never disclose invalid values", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  for (const args of [["config", "validate"], ["serve"], ["serve", "server"]]) {
    const result = invocation(args, env);
    assert.notEqual(result.status, ExitCode.Success);
    assert.ok(result.stderr.includes(env.KANTHORD_CONFIG!));
    assert.match(result.stderr, /^system\.config\.not_found:/);
    assert.deepEqual(readdirSync(directory), []);
  }
  writePrivate(env.KANTHORD_CONFIG!, "master_key: [secret-marker");
  const invalid = invocation(["config", "validate"], env);
  assert.notEqual(invalid.status, ExitCode.Success);
  assert.doesNotMatch(invalid.stderr + invalid.stdout, /secret-marker/);
  assert.match(invalid.stderr, /^system\.config\.invalid_yaml:/);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig(), true);
  assert.equal(
    invocation(["config", "validate"], env).status,
    ExitCode.Success,
  );
  const show = invocation(["config", "show"], env);
  assert.equal(show.status, ExitCode.Success);
  assert.match(show.stdout, /\[Sensitive\]/);
});

test("top-level jwt uses its optional username or the constant default, the configured key and lifetime, and terminal-only output", async (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const config = loadConfig(env.KANTHORD_CONFIG!);
  config.gateway.token_lifetime = TOKEN_LIFETIME_SECONDS;
  writePrivate(env.KANTHORD_CONFIG!, stringify(config), true);
  const redirected = invocation(["jwt", "generate"], env);
  assert.equal(redirected.status, ExitCode.Failure);
  assert.equal(redirected.stdout, EMPTY_OUTPUT);
  assert.match(redirected.stderr, /terminal/);
  const help = invocation(["jwt", "generate", "--help"], env);
  assert.equal(help.status, ExitCode.Success);
  assert.match(help.stdout, /--config <path>/);
  assert.match(help.stdout, /--output \[path\]/);
  assert.match(help.stdout, /--endpoint <url>/);
  const helpText = help.stdout.replace(/\s+/g, " ");
  assert.ok(helpText.includes(clientConfigPath(env)));
  assert.match(helpText, /creates an absent file only/);
  assert.match(helpText, /readers use only the default path/);
  assert.match(helpText, /Endpoint written to the --output file/);
  assert.match(help.stdout, /Usage: kanthord jwt generate .*\[username\]/);
  assert.ok(help.stdout.includes(KANTHORD_AUTH_USERNAME));
  assert.ok(help.stdout.includes(env.KANTHORD_CONFIG!));
  const tokens: string[] = [];
  for (const username of [undefined, "ulrich", "u".repeat(64)]) {
    const result = invocation(
      [
        "jwt",
        "generate",
        ...(username === undefined ? [] : [username]),
        "--config",
        env.KANTHORD_CONFIG!,
      ],
      { ...env, KANTHORD_CONFIG: join(directory, "absent.yaml") },
      true,
    );
    assert.equal(result.status, ExitCode.Success, result.stderr);
    const token = result.stdout.trim();
    assert.equal(result.stdout, `${token}\n`);
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
    const invalid = invocation(["jwt", "generate", ...args], env, true);
    assert.notEqual(invalid.status, ExitCode.Success);
    assert.equal(invalid.stdout, EMPTY_OUTPUT);
  }
});

test("jwt --output creates a private default client file with a verifiable human token on redirected stdout", async (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const config = loadConfig(env.KANTHORD_CONFIG!);
  const result = invocation(["jwt", "generate", "--output"], env);
  const path = clientConfigPath(env);
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, `Created ${path}\n`);
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

test("jwt --output resolves an explicit relative export path and writes the endpoint before the token", (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const path = relative(
    process.cwd(),
    join(env.XDG_CONFIG_HOME!, "ulrich.cli.yaml"),
  );
  const endpoint = "https://tunnel.example";
  const username = "ulrich";
  const result = invocation(
    ["jwt", "generate", username, "--output", path, "--endpoint", endpoint],
    env,
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, `Created ${resolve(path)}\n`);
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

test("jwt --output refuses an existing destination without changing its bytes or disclosing a token", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const path = clientConfigPath(env);
  const content =
    "endpoint: https://existing.example\ntoken: keep-this-token\n";
  writePrivate(path, content);
  const before = readdirSync(directory, { recursive: true });
  const result = invocation(["jwt", "generate", "--output", "--verbose"], env);
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /^system\.files\.publish_failed:/);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.deepEqual(readFileSync(path), Buffer.from(content));
  assert.deepEqual(readdirSync(directory, { recursive: true }), before);
  assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
  assert.ok(!result.stderr.includes("keep-this-token"));
});

test("jwt output validation precedes configuration loading and writes no file or token", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const before = readdirSync(directory, { recursive: true });
  const cases: [string[], string][] = [
    [
      ["ulrich", "--output", "--binding", "x", "--endpoint", "ftp://x"],
      "cli.jwt.username_with_binding",
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
      "cli.jwt.output_with_binding",
    ],
    [
      ["--project", PROJECT_ID, "--output", "--binding", "x"],
      "cli.jwt.output_with_binding",
    ],
    [
      ["--binding", "x", "--output", "--endpoint", "ftp://x"],
      "cli.jwt.binding_without_project",
    ],
    [
      ["--project", PROJECT_ID, "--output", "--endpoint", "ftp://x"],
      "cli.jwt.project_without_binding",
    ],
    [["--project", "invalid"], "cli.jwt.invalid_project"],
    ...[" ", "B", "b".repeat(64)].map((binding): [string[], string] => [
      ["--binding", binding],
      "gateway.authentication.invalid_binding",
    ]),
    [["--endpoint", "http://x"], "cli.jwt.endpoint_without_output"],
    [["--endpoint", "ftp://x"], "cli.jwt.endpoint_without_output"],
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
    const result = invocation(["jwt", "generate", ...options], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.deepEqual(readdirSync(directory, { recursive: true }), before);
    assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
  }
});

test("jwt --verbose --output prints creation then the existing claim list without the token", (t) => {
  const env = environment(temporary(t));
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const result = invocation(["jwt", "generate", "--verbose", "--output"], env);
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  const path = clientConfigPath(env);
  const { token } = parse(readFileSync(path, "utf8"));
  const inspected = invocation(["jwt", "inspect", token], env);
  assert.equal(inspected.status, ExitCode.Success, inspected.stderr);
  assert.equal(result.stdout, `Created ${path}\n${inspected.stdout}`);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  assert.doesNotMatch(result.stdout + result.stderr, JWT_OUTPUT);
});

test("JWT generation requires terminal output before loading configuration in both modes", (t) => {
  const env = environment(temporary(t));
  for (const options of [
    [],
    ["--project", PROJECT_ID, "--binding", "worker-binding"],
  ]) {
    const result = invocation(["jwt", "generate", ...options], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /^cli\.output\.terminal_required:/);
    assert.ok(!existsSync(env.KANTHORD_CONFIG!));
  }
});

test("jwt accepts display names and issues fresh machine identities without opening a database", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const name = "A display name";
  const binding = "worker-binding";
  const human = invocation(
    ["jwt", "generate", "ulrich", "--name", name],
    env,
    true,
  );
  assert.equal(human.status, ExitCode.Success, human.stderr);
  assert.equal(decode(human.stdout.trim()).payload.name, name);
  const subjects = new Set<string>();
  const sessions = new Set<string>();
  const secrets = new Set<string>();
  const config = loadConfig(env.KANTHORD_CONFIG!);
  const ISSUANCES = 2;
  for (let index = 0; index < ISSUANCES; index++) {
    const result = invocation(
      [
        "jwt",
        "generate",
        "--project",
        PROJECT_ID,
        "--binding",
        binding,
        ...(index ? ["--name", name] : []),
      ],
      env,
      true,
    );
    assert.equal(result.status, ExitCode.Success, result.stderr);
    const { token, client_secret: clientSecret } = parse(result.stdout);
    assert.equal(
      result.stdout,
      `token: ${token}\nclient_secret: ${clientSecret}\n`,
    );
    assert.equal(result.stderr, EMPTY_OUTPUT);
    const claims = decode(token).payload;
    assert.equal(
      clientSecret,
      deriveClientSecret(config.master_key, String(claims.sub)),
    );
    assert.equal(
      Buffer.from(clientSecret, "base64").length,
      CLIENT_SECRET_BYTES,
    );
    assert.equal(
      Buffer.from(clientSecret, "base64").toString("base64"),
      clientSecret,
    );
    secrets.add(clientSecret);
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
  assert.equal(secrets.size, ISSUANCES);
  const conflict = invocation(
    ["jwt", "generate", "ulrich", "--binding", binding],
    env,
    true,
  );
  assert.equal(conflict.status, ExitCode.Failure);
  assert.match(conflict.stderr, /^cli\.jwt\.username_with_binding:/);
  assert.equal(conflict.stdout, EMPTY_OUTPUT);
  const redirected = invocation(
    ["jwt", "generate", "--project", PROJECT_ID, "--binding", binding],
    env,
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
    const invalid = invocation(["jwt", "generate", ...options], env, true);
    assert.equal(invalid.status, ExitCode.Failure);
    assert.equal(invalid.stdout, EMPTY_OUTPUT);
  }
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
});

test("jwt group, verbose generation, inspection and token precedence", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const group = invocation(["jwt"], env);
  assert.equal(group.status, ExitCode.Success);
  assert.match(group.stdout, /generate/);
  assert.match(group.stdout, /inspect/);
  const generated = invocation(
    ["jwt", "generate", "ulrich", "--verbose"],
    env,
    true,
  );
  assert.equal(generated.status, ExitCode.Success, generated.stderr);
  const [token, ...claimLines] = generated.stdout.split("\n");
  assert.ok(token);
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
  const rootVerbose = invocation(["--verbose", "jwt", "generate"], env, true);
  assert.equal(rootVerbose.status, ExitCode.Success, rootVerbose.stderr);
  assert.match(rootVerbose.stdout, /^\S+\n---\n/);
  const plain = invocation(["jwt", "generate"], env, true);
  assert.equal(plain.status, ExitCode.Success, plain.stderr);
  assert.match(plain.stdout, /^\S+\n$/);
  const inspect = invocation(["jwt", "inspect", token], env);
  assert.equal(inspect.status, ExitCode.Success, inspect.stderr);
  assert.equal(inspect.stdout, claimList);
  const machine = invocation(
    [
      "jwt",
      "generate",
      "--project",
      PROJECT_ID,
      "--binding",
      "worker-binding",
      "--verbose",
    ],
    env,
    true,
  );
  assert.equal(machine.status, ExitCode.Success, machine.stderr);
  const [tokenLine, secretLine, ...machineClaims] = machine.stdout.split("\n");
  const machineToken = tokenLine!.slice("token: ".length);
  const machineSecret = deriveClientSecret(
    loadConfig(env.KANTHORD_CONFIG!).master_key,
    String(decode(machineToken).payload.sub),
  );
  assert.equal(tokenLine, `token: ${machineToken}`);
  assert.equal(secretLine, `client_secret: ${machineSecret}`);
  const machineInspect = invocation(["jwt", "inspect", machineToken], env);
  assert.equal(machineInspect.status, ExitCode.Success, machineInspect.stderr);
  assert.equal(machineClaims.join("\n"), machineInspect.stdout);
  assert.match(machineInspect.stdout, new RegExp(`project_id: ${PROJECT_ID}`));
  assert.match(
    machineInspect.stdout,
    /resource_identity: worker:kanthord:worker-binding/,
  );
  assert.doesNotMatch(machineInspect.stdout, /^binding:/m);
  assert.equal(machine.stderr, EMPTY_OUTPUT);
  const other = plain.stdout.trim();
  writePrivate(clientConfigPath(env), `token: ${other}\n`);
  assert.equal(
    invocation(["jwt", "inspect"], env).stdout,
    invocation(["jwt", "inspect", other], env).stdout,
  );
  assert.equal(
    invocation(["jwt", "inspect"], { ...env, KANTHORD_TOKEN: token }).stdout,
    claimList,
  );
  assert.equal(
    invocation(["jwt", "inspect", other], { ...env, KANTHORD_TOKEN: token })
      .stdout,
    invocation(["jwt", "inspect", other], env).stdout,
  );
  const absent = invocation(["jwt", "inspect"], environment(temporary(t)));
  assert.equal(absent.status, ExitCode.Failure);
  assert.match(absent.stderr, /^cli\.jwt\.inspect\.token_required:/);
  for (const invalid of [
    "not-a-jwt",
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from("[]").toString("base64url")}.sig`,
  ]) {
    const result = invocation(["jwt", "inspect", invalid], env);
    assert.equal(result.status, ExitCode.Failure);
    assert.match(result.stderr, /^cli\.jwt\.inspect\.malformed_token:/);
    assert.ok(!result.stderr.includes(invalid));
  }
  assert.notEqual(
    invocation(["jwt", "inspect", "--config", "x"], env).status,
    ExitCode.Success,
  );
  const baseline = invocation(["config", "validate"], env);
  const verbose = invocation(["config", "validate", "--verbose"], env);
  assert.equal(verbose.stdout, baseline.stdout);
  assert.equal(verbose.status, baseline.status);
});

test("launcher rejects an unsupported runtime before importing application code", () => {
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

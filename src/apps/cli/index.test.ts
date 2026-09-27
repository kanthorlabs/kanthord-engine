import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { temporary } from "../../kernel/test-support.ts";
import { initialConfig, loadConfig } from "../../config/index.ts";
import { IdentityKind, CLIENT_IDENTITY_PREFIX } from "../../kernel/caller.ts";
import { KANTHORD_AUTH_USERNAME } from "../../gateway/local.ts";
import { decode, verify } from "hono/jwt";
import { identitySchema } from "../../kernel/identity.ts";
import { deriveKey } from "../../kernel/json.ts";
import { stringify } from "yaml";
import { PRIVATE_FILE_MODE, writePrivate } from "../../kernel/files.ts";
import { clientConfigPath } from "../../gateway/client.ts";

import { ExitCode } from "./constants.ts";

const EMPTY_OUTPUT = "";
const SINGLE_DIAGNOSTIC_LINE = 1;
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

test("worker agent enablement commands expose offline help and validate inputs before I/O", (t) => {
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
    const help = invocation(
      ["worker", "agent", "enablement", ...path, "--help"],
      env,
    );
    assert.equal(help.status, ExitCode.Success, help.stderr);
    if (fileRequired) assert.match(help.stdout, /--file <path>/);
  }
  assert.equal(
    invocation(["worker", "register", "--help"], env).status,
    ExitCode.Success,
  );
  const invalid = invocation(
    [
      "worker",
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
    /^cli\.worker\.agent\.enablement\.enable\.invalid_revision:/,
  );
  const missingToken = invocation(
    [
      "worker",
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
    /^cli\.worker\.agent\.enablement\.put\.token_required:/,
  );
});

test("serve worker rejects server configuration and uses a single transport diagnostic without starting", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const config = invocation(
    ["serve", "worker", "--config", "private.yaml"],
    env,
  );
  assert.equal(config.status, ExitCode.Failure);
  assert.match(config.stderr, /^cli\.serve\.worker_config:/);
  const unavailable = invocation(
    ["serve", "worker", "--endpoint", "http://127.0.0.1:1", "--token", "x"],
    env,
  );
  assert.equal(unavailable.status, ExitCode.Failure);
  assert.equal(unavailable.stdout, EMPTY_OUTPUT);
  assert.equal(
    unavailable.stderr.trim().split("\n").length,
    SINGLE_DIAGNOSTIC_LINE,
  );
  assert.match(unavailable.stderr, /^worker\.version\.unavailable:/);
  assert.deepEqual(readdirSync(directory), []);
});

test("config init is non-interactive, writes validated private configuration without displaying secrets and preserves existing files", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  const accepted = invocation(["config", "init"], env);
  assert.equal(accepted.status, ExitCode.Success, accepted.stderr);
  const content = readFileSync(env.KANTHORD_CONFIG!, "utf8");
  assert.equal(accepted.stdout, `Created ${env.KANTHORD_CONFIG!}\n`);
  assert.ok(
    !accepted.stdout.includes(loadConfig(env.KANTHORD_CONFIG!).masterKey),
  );
  assert.equal(statSync(env.KANTHORD_CONFIG!).mode & 0o777, PRIVATE_FILE_MODE);
  const existing = invocation(["config", "init"], env);
  assert.notEqual(existing.status, ExitCode.Success);
  assert.equal(readFileSync(env.KANTHORD_CONFIG!, "utf8"), content);
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
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
  writePrivate(env.KANTHORD_CONFIG!, "masterKey: [secret-marker");
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
  config.gateway.tokenLifetime = TOKEN_LIFETIME_SECONDS;
  writePrivate(env.KANTHORD_CONFIG!, stringify(config), true);
  const redirected = invocation(["jwt"], env);
  assert.equal(redirected.status, ExitCode.Failure);
  assert.equal(redirected.stdout, EMPTY_OUTPUT);
  assert.match(redirected.stderr, /terminal/);
  const help = invocation(["jwt", "--help"], env);
  assert.equal(help.status, ExitCode.Success);
  assert.match(help.stdout, /--config <path>/);
  assert.match(help.stdout, /Usage: kanthord jwt .*\[username\]/);
  assert.ok(help.stdout.includes(KANTHORD_AUTH_USERNAME));
  assert.ok(help.stdout.includes(env.KANTHORD_CONFIG!));
  const tokens: string[] = [];
  for (const username of [undefined, "ulrich", "u".repeat(64)]) {
    const result = invocation(
      [
        "jwt",
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
      new Uint8Array(deriveKey(config.masterKey, "gateway/jwt-hs256/v1")),
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
    const invalid = invocation(["jwt", ...args], env, true);
    assert.notEqual(invalid.status, ExitCode.Success);
    assert.equal(invalid.stdout, EMPTY_OUTPUT);
  }
});

test("jwt accepts display names and issues fresh machine identities without opening a database", (t) => {
  const directory = temporary(t);
  const env = environment(directory);
  writePrivate(env.KANTHORD_CONFIG!, initialConfig());
  const name = "A display name";
  const binding = "worker-binding";
  const human = invocation(["jwt", "ulrich", "--name", name], env, true);
  assert.equal(human.status, ExitCode.Success, human.stderr);
  assert.equal(decode(human.stdout.trim()).payload.name, name);
  const subjects = new Set<string>();
  const sessions = new Set<string>();
  const ISSUANCES = 2;
  for (let index = 0; index < ISSUANCES; index++) {
    const result = invocation(
      ["jwt", "--binding", binding, ...(index ? ["--name", name] : [])],
      env,
      true,
    );
    assert.equal(result.status, ExitCode.Success, result.stderr);
    const claims = decode(result.stdout.trim()).payload;
    assert.equal(claims.kind, IdentityKind.Client);
    assert.equal(claims.binding, binding);
    assert.ok(
      identitySchema(CLIENT_IDENTITY_PREFIX).safeParse(claims.sub).success,
    );
    assert.equal(claims.name, index ? name : claims.sub);
    subjects.add(String(claims.sub));
    sessions.add(String(claims.jti));
  }
  assert.equal(subjects.size, ISSUANCES);
  assert.equal(sessions.size, ISSUANCES);
  const conflict = invocation(
    ["jwt", "ulrich", "--binding", binding],
    env,
    true,
  );
  assert.equal(conflict.status, ExitCode.Failure);
  assert.match(conflict.stderr, /^cli\.jwt\.username_with_binding:/);
  assert.equal(conflict.stdout, EMPTY_OUTPUT);
  const redirected = invocation(["jwt", "--binding", binding], env);
  assert.equal(redirected.status, ExitCode.Failure);
  assert.equal(redirected.stdout, EMPTY_OUTPUT);
  for (const options of [
    ["--name", " "],
    ["--name", "n".repeat(65)],
    ["--binding", " "],
    ["--binding", "b".repeat(129)],
  ]) {
    const invalid = invocation(["jwt", ...options], env, true);
    assert.equal(invalid.status, ExitCode.Failure);
    assert.equal(invalid.stdout, EMPTY_OUTPUT);
  }
  assert.deepEqual(readdirSync(directory), ["kanthord.yaml"]);
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

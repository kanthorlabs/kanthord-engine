import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  AMBIENT_CREDENTIAL_NAMES,
  PROXY_NAMES,
  toolChildEnvironment,
  withoutAmbientCredentials,
} from "./run-agent-environment.ts";

const AMBIENT_LIST_NAME = "AMBIENT_CREDENTIAL_NAMES";
const EIGHT_PROXY_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];
const CHILD_NAMES = [
  "GIT_CONFIG_NOSYSTEM",
  "GIT_SSH_COMMAND",
  "HOME",
  "LANG",
  "PATH",
  "TMPDIR",
];
const SHELL_SSH_COMMAND = "ssh -i /old/key";
const AGENT_HOME = "/run/agent/home";
const AGENT_TMP = "/run/agent/tmp";
const AWS_CONFIG_PATH = "/run/agent/home/.aws/config";
const AWS_CREDENTIALS_PATH = "/run/agent/home/.aws/credentials";
const EC2_METADATA_VALUE = "true";
const METADATA_DETECTION_VALUE = "none";
const PATH_VALUE = "/usr/bin:/usr/local/bin";
const LANG_VALUE = "en_US.UTF-8";

function taskSeedAmbientNames(): string[] {
  const path = fileURLToPath(
    new URL("../../worker/unit/tasks-seed.ts", import.meta.url),
  );
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === AMBIENT_LIST_NAME &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    )
      for (const element of node.initializer.elements)
        if (ts.isStringLiteral(element)) names.push(element.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

describe("removal list", () => {
  it("equals AMBIENT_CREDENTIAL_NAMES of tasks run plus the eight proxy names", () => {
    const seedNames = taskSeedAmbientNames();
    assert.ok(seedNames.length);
    assert.deepEqual(
      [...AMBIENT_CREDENTIAL_NAMES, ...PROXY_NAMES].sort(),
      [...seedNames, ...EIGHT_PROXY_NAMES].sort(),
    );
  });
});

describe("withoutAmbientCredentials", () => {
  it("removes ambient credential names from env", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/old-home",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "fixture-secret",
      GOOGLE_API_KEY: "fixture-google-key",
    };
    withoutAmbientCredentials(env, "/run/home", "/run/tmp");
    assert.equal(env["AWS_ACCESS_KEY_ID"], undefined);
    assert.equal(env["AWS_SECRET_ACCESS_KEY"], undefined);
    assert.equal(env["GOOGLE_API_KEY"], undefined);
  });

  it("removes proxy names from env", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.example:3128",
      http_proxy: "http://proxy.example:3128",
      HTTPS_PROXY: "http://proxy.example:3128",
      https_proxy: "http://proxy.example:3128",
      ALL_PROXY: "socks5://proxy.example:1080",
      all_proxy: "socks5://proxy.example:1080",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
    };
    withoutAmbientCredentials(env, "/run/home", "/run/tmp");
    for (const name of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ])
      assert.equal(env[name], undefined);
  });

  it("sets HOME and TMPDIR from given paths", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/old" };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["HOME"], AGENT_HOME);
    assert.equal(env["TMPDIR"], AGENT_TMP);
  });

  it("sets AWS config path variables under home", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["AWS_CONFIG_FILE"], AWS_CONFIG_PATH);
    assert.equal(env["AWS_SHARED_CREDENTIALS_FILE"], AWS_CREDENTIALS_PATH);
  });

  it("sets AWS_EC2_METADATA_DISABLED and METADATA_SERVER_DETECTION", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["AWS_EC2_METADATA_DISABLED"], EC2_METADATA_VALUE);
    assert.equal(env["METADATA_SERVER_DETECTION"], METADATA_DETECTION_VALUE);
  });

  it("keeps unrelated environment variables", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/usr/local/bin",
      LANG: "en_US.UTF-8",
    };
    withoutAmbientCredentials(env, "/run/agent/home", "/run/agent/tmp");
    assert.equal(env["PATH"], PATH_VALUE);
    assert.equal(env["LANG"], LANG_VALUE);
  });
});

describe("toolChildEnvironment", () => {
  it("gives only the shell names, the run directories and the fixed git names", () => {
    const env = toolChildEnvironment(
      {
        PATH: PATH_VALUE,
        LANG: LANG_VALUE,
        HOME: "/old",
        TMPDIR: "/old/tmp",
        USER: "someone",
        AWS_CONFIG_FILE: AWS_CONFIG_PATH,
        GIT_SSH_COMMAND: SHELL_SSH_COMMAND,
      },
      AGENT_HOME,
      AGENT_TMP,
    );
    assert.deepEqual(Object.keys(env).sort(), CHILD_NAMES);
    assert.equal(env["PATH"], PATH_VALUE);
    assert.equal(env["LANG"], LANG_VALUE);
    assert.equal(env["HOME"], AGENT_HOME);
    assert.equal(env["TMPDIR"], AGENT_TMP);
    assert.notEqual(env["GIT_SSH_COMMAND"], SHELL_SSH_COMMAND);
  });

  it("omits a shell name that the shell does not set", () => {
    const env = toolChildEnvironment(
      { PATH: PATH_VALUE },
      AGENT_HOME,
      AGENT_TMP,
    );
    assert.ok(!Object.hasOwn(env, "LANG"));
  });
});

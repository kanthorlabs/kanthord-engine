import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDocument,
  checksOf,
  environmentRefusal,
  environmentSchema,
  jsoncText,
  lifecycleScripts,
  parseEnvironmentText,
  setupScriptsOf,
} from "./devcontainer.ts";

test("an environment text parses with comments and trailing commas", () => {
  const parsed = parseEnvironmentText(`{
    // the base image
    "image": "mcr.microsoft.com/devcontainers/python:3.12",
    "postCreateCommand": "pip install -r requirements.txt",
  }`);
  assert.deepEqual(parsed, {
    document: {
      image: "mcr.microsoft.com/devcontainers/python:3.12",
      postCreateCommand: "pip install -r requirements.txt",
    },
    error: null,
  });
});

test("an environment text that is not a JSON object is invalid", () => {
  for (const text of ["[]", "1", "{", '{"image": 1}', ""])
    assert.equal(parseEnvironmentText(text).document, null, text);
  assert.match(parseEnvironmentText("{").error ?? "", /JSON/);
});

test("a lifecycle command keeps the order of its forms", () => {
  assert.deepEqual(lifecycleScripts(undefined), []);
  assert.deepEqual(lifecycleScripts("npm ci"), ["npm ci"]);
  assert.deepEqual(lifecycleScripts(["pip", "install", "it's"]), [
    "'pip' 'install' 'it'\\''s'",
  ]);
  assert.deepEqual(
    lifecycleScripts({ first: "make deps", second: ["make", "build"] }),
    ["make deps", "'make' 'build'"],
  );
});

test("setup runs the update content command before the post create command", () => {
  const document = environmentSchema.parse({
    onCreateCommand: "apt-get install -y libpq-dev",
    updateContentCommand: "npm ci",
    postCreateCommand: ["npm", "run", "build"],
  });
  assert.deepEqual(setupScriptsOf(document), ["npm ci", "'npm' 'run' 'build'"]);
  assert.deepEqual(setupScriptsOf(environmentSchema.parse({})), []);
});

test("an environment refuses a lifecycle command of a wrong type", () => {
  for (const postCreateCommand of [1, [], "", { name: 2 }])
    assert.equal(
      environmentSchema.safeParse({ postCreateCommand }).success,
      false,
    );
});

test("a JSONC text drops comments and trailing commas outside strings only", () => {
  assert.deepEqual(
    JSON.parse(
      jsoncText(`{
        "url": "http://host/*not*/a//comment", /* block */
        "quote": "a \\" , ]", // line
        "list": [1, 2, ],
        "nested": {"a": [ { }, ], },
      }`)!,
    ),
    {
      url: "http://host/*not*/a//comment",
      quote: 'a " , ]',
      list: [1, 2],
      nested: { a: [{}] },
    },
  );
  assert.equal(jsoncText('{"a": 1 /* open'), null);
  assert.match(parseEnvironmentText('{"a": 1 /* open').error ?? "", /comment/);
  assert.equal(parseEnvironmentText("[1,]").document, null);
});

test("an environment refuses every key that the build path does not allow, and names the key", () => {
  const image = "mcr.microsoft.com/devcontainers/base:bookworm";
  for (const [document, key] of [
    [
      { image, build: { dockerfile: "Dockerfile", options: ["-v=/:/h"] } },
      "build.options",
    ],
    [
      { image, build: { dockerfile: "Dockerfile", cacheFrom: "x" } },
      "build.cacheFrom",
    ],
    [{ dockerComposeFile: "compose.yml" }, "dockerComposeFile"],
    [{ image, runArgs: ["--privileged"] }, "runArgs"],
    [{ image, mounts: ["source=/,target=/h,type=bind"] }, "mounts"],
    [{ image, privileged: true }, "privileged"],
    [{ image, capAdd: ["SYS_ADMIN"] }, "capAdd"],
    [{ image, initializeCommand: "id" }, "initializeCommand"],
    [{ dockerFile: "Dockerfile" }, "dockerFile"],
  ] as const)
    assert.deepEqual(environmentRefusal(document), {
      key,
      reason: "the key is not allowed",
    });
});

test("an environment drops the keys that never reach the build", () => {
  const document = {
    $schema: "x",
    name: "dev",
    image: "base",
    customizations: { vscode: { extensions: ["a"] } },
    forwardPorts: [3000],
    init: true,
    appPort: [8080],
    secrets: { TOKEN: { description: "a token" } },
    remoteUser: "vscode",
    postStartCommand: "start",
    postCreateCommand: "npm ci",
  };
  assert.equal(environmentRefusal(document), null);
  assert.deepEqual(buildDocument(document), {
    image: "base",
    postCreateCommand: "npm ci",
  });
});

test("an environment refuses a value that reads a server variable", () => {
  for (const [document, key] of [
    [
      { build: { dockerfile: "D", args: { LEAK: "${localEnv:GH_TOKEN}" } } },
      "build.args.LEAK",
    ],
    [
      { image: "b", containerEnv: { TOKEN: "x${env:HOME}" } },
      "containerEnv.TOKEN",
    ],
    [
      { image: "b", onCreateCommand: ["sh", "${localEnv:A}"] },
      "onCreateCommand.1",
    ],
  ] as const)
    assert.deepEqual(environmentRefusal(document), {
      key,
      reason: "the value reads a server variable",
    });
});

test("an environment refuses a build path or a local feature outside the checkout", () => {
  for (const [document, key] of [
    [{ build: { dockerfile: "/etc/Dockerfile" } }, "build.dockerfile"],
    [{ build: { dockerfile: "../../Dockerfile" } }, "build.dockerfile"],
    [{ build: { dockerfile: "D", context: "../.." } }, "build.context"],
    [{ build: { dockerfile: "D", context: "/" } }, "build.context"],
    [{ image: "b", features: { "/opt/feature": {} } }, "features./opt/feature"],
    [{ image: "b", features: { "../feature": {} } }, "features.../feature"],
  ] as const)
    assert.deepEqual(environmentRefusal(document), {
      key,
      reason: "the path leaves the checkout",
    });
  assert.equal(
    environmentRefusal({
      build: { dockerfile: "../Dockerfile", context: ".." },
      features: { "./local": {}, "ghcr.io/devcontainers/features/node:1": {} },
    }),
    null,
  );
});

test("an environment refuses a variable name or value that a Containerfile line cannot hold", () => {
  assert.deepEqual(
    environmentRefusal({ image: "b", containerEnv: { "BAD NAME": "x" } }),
    { key: "containerEnv.BAD NAME", reason: "the variable name is not valid" },
  );
  assert.deepEqual(
    environmentRefusal({ image: "b", remoteEnv: { GOOD: "a\nRUN id" } }),
    { key: "remoteEnv.GOOD", reason: "the value holds a control character" },
  );
  assert.equal(
    environmentRefusal({ image: "b", remoteEnv: { DROPPED: null } }),
    null,
  );
});

test("an environment text drops every inert key", () => {
  const parsed = parseEnvironmentText(`{
    "$schema": "x",
    "name": "dev",
    "image": "base",
    "forwardPorts": [3000],
    "portsAttributes": {},
    "otherPortsAttributes": {},
    "remoteUser": "vscode",
    "containerUser": "vscode",
    "updateRemoteUserUID": true,
    "userEnvProbe": "none",
    "overrideCommand": false,
    "shutdownAction": "none",
    "hostRequirements": {},
    "waitFor": "postCreateCommand",
    "postStartCommand": "start",
    "postAttachCommand": "attach",
    "workspaceFolder": "/w",
    "init": true,
    "appPort": [8080],
    "secrets": {},
    "customizations": { "vscode": {} }
  }`);
  assert.deepEqual(parsed, { document: { image: "base" }, error: null });
});

test("an environment text keeps customizations.kanthord and drops the other tools", () => {
  const parsed = parseEnvironmentText(
    JSON.stringify({
      customizations: {
        vscode: { extensions: ["x"] },
        kanthord: { checks: ["node --version"] },
      },
    }),
  );
  assert.deepEqual(parsed, {
    document: { customizations: { kanthord: { checks: ["node --version"] } } },
    error: null,
  });
});

test("an environment text refuses a check list of a wrong type", () => {
  const many = Array.from({ length: 33 }, () => "true");
  for (const checks of [many, [""], ["   "], [1], "node", {}]) {
    const parsed = parseEnvironmentText(
      JSON.stringify({ customizations: { kanthord: { checks } } }),
    );
    assert.equal(parsed.document, null);
    assert.match(parsed.error ?? "", /customizations\.kanthord\.checks/);
  }
  const edge = Array.from({ length: 32 }, () => "true");
  assert.equal(
    parseEnvironmentText(
      JSON.stringify({ customizations: { kanthord: { checks: edge } } }),
    ).error,
    null,
  );
});

test("an environment refuses another key of customizations.kanthord", () => {
  assert.deepEqual(
    environmentRefusal({ customizations: { kanthord: { other: 1 } } }),
    { key: "customizations.kanthord.other", reason: "the key is not allowed" },
  );
  assert.equal(
    environmentRefusal({
      customizations: { vscode: {}, kanthord: { checks: ["a"] } },
    }),
    null,
  );
});

test("checksOf answers the checks or an empty list", () => {
  assert.deepEqual(checksOf({}), []);
  assert.deepEqual(checksOf({ customizations: {} }), []);
  assert.deepEqual(checksOf({ customizations: { kanthord: {} } }), []);
  assert.deepEqual(
    checksOf({ customizations: { kanthord: { checks: ["a", "b"] } } }),
    ["a", "b"],
  );
});

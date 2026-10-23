import assert from "node:assert/strict";
import { test } from "node:test";
import {
  environmentSchema,
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

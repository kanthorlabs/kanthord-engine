import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";

const EXIT_SUCCESS = 0;
const NOT_FOUND = -1;
const NONE = 0;
const HELP = "--help";
const COMMANDS_HEADER = "Commands:";
const COMMAND_ROW = /^  (\S+)(?:\s|$)/gm;

const cases = [
  {
    id: "E08.1",
    args: [],
    names: ["credential", "project", "mission", "scheduler", "worker"],
  },
  {
    id: "E08.2",
    args: ["credential"],
    names: [
      "create",
      "list",
      "get",
      "rotate",
      "archive",
      "update-metadata",
      "revoke",
      "login",
      "login-code",
      "login-status",
      "platforms",
    ],
    exact: true,
  },
  { id: "E08.3", args: ["worker"], names: ["agent"] },
  { id: "E08.4", args: ["worker", "agent"], names: ["enablement"] },
  {
    id: "E08.5",
    args: ["worker", "agent", "enablement"],
    names: ["list", "get", "put", "enable", "disable", "remove", "provider"],
  },
  {
    id: "E08.6",
    args: ["project"],
    names: ["create", "list", "get", "rename", "binding", "agent"],
  },
  {
    id: "E08.7",
    args: ["project", "binding"],
    names: ["list", "get", "export", "apply", "revision"],
  },
  { id: "E08.8", args: ["project", "agent"], names: ["list", "get"] },
  {
    id: "E08.9",
    args: ["mission"],
    names: [
      "get",
      "node",
      "edge",
      "dependency",
      "criterion",
      "export",
      "import",
    ],
  },
  { id: "E08.10", args: ["scheduler"], names: ["queue"] },
  { id: "E08.11", args: ["scheduler", "queue"], names: ["list", "peek"] },
  {
    id: "E08.12",
    args: ["worker", "agent", "enablement", "provider"],
    names: ["add", "remove"],
  },
  {
    id: "E08.13",
    args: ["mission", "node"],
    names: [
      "list",
      "get",
      "create",
      "update",
      "move",
      "revision",
      "retire",
      "rebind",
      "priority",
    ],
  },
  { id: "E08.14", args: ["mission", "import"], names: ["preview", "apply"] },
];

function commandNames(stdout: string): string[] {
  const lines = stdout.split("\n");
  const header = lines.indexOf(COMMANDS_HEADER);
  assert.notEqual(header, NOT_FOUND, stdout);
  const section = lines
    .slice(header + 1)
    .join("\n")
    .split(/\n(?=\S)/, 1)[0];
  assert.ok(section !== undefined, stdout);
  const names: string[] = [];
  for (const match of section.matchAll(COMMAND_ROW)) {
    const name = match[1];
    assert.ok(name !== undefined, stdout);
    names.push(name);
  }
  assert.ok(names.length > NONE, stdout);
  return names;
}

for (const scenario of cases) {
  test(scenario.id, async (t) => {
    const directory = temporary(t);
    const env = {
      ...environment(directory),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      KANTHORD_ENDPOINT: undefined,
      KANTHORD_TOKEN: undefined,
    };
    const result = await kanthord([...scenario.args, HELP], env);
    assert.equal(result.code, EXIT_SUCCESS, result.stderr);
    const names = commandNames(result.stdout);
    if (scenario.exact) {
      assert.deepEqual(names.sort(), [...scenario.names].sort());
    } else {
      for (const name of scenario.names) {
        assert.ok(
          names.includes(name),
          `${scenario.id}: missing ${name}; found ${names.join(", ")}`,
        );
      }
    }
  });
}

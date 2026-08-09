import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRemoteRefs,
  remoteRefsScript,
  runRemoteRefs,
  type RemoteRefsInput,
} from "./remote-refs.ts";
import type { CommandRecord } from "./command.ts";

function record(input: Partial<CommandRecord> = {}): CommandRecord {
  return {
    argv: input.argv ?? ["git", "ls-remote"],
    cwd: input.cwd ?? process.cwd(),
    exitCode: input.exitCode ?? 0,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  };
}

const input: RemoteRefsInput = {
  origin: "https://github.com/owner/repository.git",
  username: "x-access-token",
  tokenPath: "/tmp/token",
};

test("remoteRefsScript embeds the token path and never the token", () => {
  const script = remoteRefsScript(input);

  assert.equal(script.includes("cat /tmp/token"), true);
  assert.equal(script.includes("secret-token-value"), false);
});

test("parseRemoteRefs maps every oid line and ignores the rest", () => {
  const stdout =
    "ref: refs/heads/main\tHEAD\n" +
    `${"a".repeat(40)}\tHEAD\n` +
    `${"b".repeat(40)}\trefs/heads/main\n\n`;

  assert.deepEqual(parseRemoteRefs(stdout), {
    HEAD: "a".repeat(40),
    "refs/heads/main": "b".repeat(40),
  });
});

test("parseRemoteRefs accepts a sixty-four character object id", () => {
  assert.deepEqual(parseRemoteRefs(`${"c".repeat(64)}\trefs/heads/main\n`), {
    "refs/heads/main": "c".repeat(64),
  });
});

test("parseRemoteRefs returns keys in bytewise-ascending ref order", () => {
  const refs = ["refs/heads/z", "refs/tags/é", "refs/heads/a"];
  const stdout = refs
    .map((ref, index) => `${String(index + 1).repeat(40)}\t${ref}`)
    .join("\n");

  const expected = [...refs].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );

  assert.deepEqual(Object.keys(parseRemoteRefs(stdout)), expected);
});

test("parseRemoteRefs keeps the last oid when a ref repeats", () => {
  assert.deepEqual(
    parseRemoteRefs(
      `${"a".repeat(40)}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/main\n`,
    ),
    { "refs/heads/main": "b".repeat(40) },
  );
});

test("runRemoteRefs returns the parsed map on exit status zero", async () => {
  let scriptSeen = "";
  const result = await runRemoteRefs(async (script) => {
    scriptSeen = script;
    return record({
      stdout: `${"d".repeat(40)}\trefs/heads/main\n`,
    });
  }, input);

  assert.equal(scriptSeen, remoteRefsScript(input));
  assert.deepEqual(result, { "refs/heads/main": "d".repeat(40) });
});

test("runRemoteRefs raises unavailable on a non-zero exit", async () => {
  await assert.rejects(
    runRemoteRefs(async () => record({ exitCode: 128 }), {
      ...input,
      origin: "https://github.com/o/r.git",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: unknown }).code, "unavailable");
      assert.equal(
        error.message,
        "git ls-remote against https://github.com/o/r.git exited 128",
      );
      return true;
    },
  );
});

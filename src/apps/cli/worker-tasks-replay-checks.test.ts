import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { suite, test } from "node:test";
import { PI_DIRECTORY_NAME, usePiDirectory } from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { temporaryDirectory } from "../../kernel/test-support.ts";
import {
  fauxAssistantMessage,
  scriptedProvider,
  type ScriptedProvider,
} from "../../worker/unit/test-support.ts";
import { TasksErrorCode, TasksExit } from "../worker/index.ts";
import {
  checkOf,
  checkoutOf,
  countedCapabilities,
  diagnosticOf,
  replayOptions,
  runOptions,
  type SeedFixture,
  seedFixture,
  commandRun as sharedCommandRun,
  TEST_TIMEOUT_MS,
  type ToolCounts,
  toolUse,
  turnLines,
  TURNS_FILE,
  writeGood,
} from "./tasks-test-support.ts";
import { type TasksCommandIo, tasksRun } from "./worker-tasks.ts";

const PI_ROOT = temporaryDirectory();
const PI_DIRECTORY = join(PI_ROOT, PI_DIRECTORY_NAME);
process.on("exit", () => rmSync(PI_ROOT, { recursive: true, force: true }));
installPiTools({ directory: PI_DIRECTORY });
usePiDirectory(PI_DIRECTORY);

const REPLAY_CHECK = 8;
const NO_CALLS = 0;
const NEWLINE = "\n";
const ANSWER_KIND = "answer";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const COMMIT_FORMAT = "--format=%H%n%T%n%B";
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@localhost"];
const SIGNATURE = [
  "gpgsig -----BEGIN PGP SIGNATURE-----",
  " ",
  " c2lnbmF0dXJl",
  " -----END PGP SIGNATURE-----",
].join(NEWLINE);

function commandRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
) {
  return sharedCommandRun(fixture, provider, {
    piDirectory: PI_DIRECTORY,
    ...overrides,
  });
}

async function liveRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
): Promise<string> {
  const run = commandRun(fixture, provider, overrides);
  const code = await tasksRun(
    fixture.seedFolder,
    runOptions(fixture, { verify: true }),
    run.io,
  );
  assert.equal(code, TasksExit.Success, run.stderr.join(""));
  return join(fixture.root, "out", TURNS_FILE);
}

function replayRun(
  fixture: SeedFixture,
  turns: string,
  overrides: Partial<TasksCommandIo> = {},
  output = join(fixture.root, "replay"),
): Promise<TasksExit> {
  const replay = commandRun(fixture, scriptedProvider([]), overrides);
  return tasksRun(
    fixture.seedFolder,
    replayOptions(fixture, turns, { output }),
    replay.io,
  );
}

function git(directory: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", directory, ...IDENTITY, ...args], {
    encoding: "utf8",
    input,
  });
}

function signedHead(checkout: string): string {
  const commit = git(checkout, ["cat-file", "commit", "HEAD"]);
  const lines = commit.split(NEWLINE);
  const committer = lines.findIndex((line) => line.startsWith("committer "));
  lines.splice(committer + 1, NO_CALLS, SIGNATURE);
  const signed = git(
    checkout,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    lines.join(NEWLINE),
  ).trim();
  git(checkout, ["reset", "--soft", signed]);
  return signed;
}

suite("worker tasks run replay checks", () => {
  test(
    "an open-world tool result with a JWT-like text replays with no divergence",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const counts: ToolCounts = { openWorld: NO_CALLS, closedWorld: NO_CALLS };
      const capabilities = countedCapabilities(counts, () => ({
        content: [{ type: "text", text: `token ${JWT}` }],
        details: {},
      }));
      const turns = await liveRun(
        fixture,
        scriptedProvider([
          toolUse("link_update_list", {}),
          writeGood(),
          fauxAssistantMessage("done"),
        ]),
        { capabilities },
      );
      assert.ok(!readFileSync(turns, "utf8").includes(JWT));
      const code = await replayRun(fixture, turns, { capabilities });
      assert.equal(code, TasksExit.Success);
    },
  );

  test(
    "an answer that the writer redacts is marked, and its replay stops with replay_diverged, reason redacted_record, at that turn",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(
        fixture,
        scriptedProvider([
          toolUse("write", { path: "token.txt", content: JWT }),
          writeGood(),
          fauxAssistantMessage("done"),
        ]),
      );
      const answers = turnLines(join(fixture.root, "out")).filter(
        (line) => line.kind === ANSWER_KIND,
      );
      assert.deepEqual(
        answers.map((line) => line.redacted),
        [true, undefined, undefined],
      );
      assert.ok(!readFileSync(turns, "utf8").includes(JWT));
      const failed = await diagnosticOf(replayRun(fixture, turns));
      assert.deepEqual(
        [failed.code, failed.fields],
        [
          TasksErrorCode.ReplayDiverged,
          [
            ["turn", "1"],
            ["reason", "redacted_record"],
            ["step", "unit.turn"],
          ],
        ],
      );
    },
  );

  test(
    "a completed replay that leaves a recorded turn unused ends with replay_diverged, reason turns_unused",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(
        fixture,
        scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      );
      const lines = readFileSync(turns, "utf8").trimEnd().split(NEWLINE);
      appendFileSync(turns, `${lines.slice(-2).join(NEWLINE)}${NEWLINE}`);
      const failed = await diagnosticOf(replayRun(fixture, turns));
      assert.deepEqual(
        [failed.code, failed.fields],
        [
          TasksErrorCode.ReplayDiverged,
          [
            ["turn", "2"],
            ["reason", "turns_unused"],
          ],
        ],
      );
    },
  );

  test(
    "a bash call with truncated output replays with no divergence",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(
        fixture,
        scriptedProvider([
          toolUse("bash", { command: "seq 1 5000" }),
          writeGood(),
          fauxAssistantMessage("done"),
        ]),
      );
      assert.match(readFileSync(turns, "utf8"), /<kanthord:pi-bash-log>/);
      assert.equal(await replayRun(fixture, turns), TasksExit.Success);
    },
  );

  test(
    "a recorded tree with another commit fails check 8 and ends with exit 4",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(
        fixture,
        scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      );
      const checkout = checkoutOf(join(fixture.root, "out"));
      git(checkout, ["commit", "--allow-empty", "-m", "extra"]);
      assert.equal(await replayRun(fixture, turns), TasksExit.VerifyFailed);
      assert.equal(
        checkOf(join(fixture.root, "replay"), REPLAY_CHECK)?.passed,
        false,
      );
    },
  );

  test(
    "check 8 runs no signature program that the config of a recorded tree names",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(
        fixture,
        scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      );
      const out = join(fixture.root, "out");
      const checkout = checkoutOf(out);
      const marker = join(fixture.root, "gpg-ran");
      const program = join(fixture.root, "gpg.sh");
      writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      chmodSync(program, 0o755);
      git(checkout, ["config", "log.showSignature", "true"]);
      git(checkout, ["config", "gpg.program", program]);
      const head = git(checkout, ["rev-parse", "HEAD"]).trim();
      const signed = signedHead(checkout);
      const outbox = join(out, "outbox.json");
      writeFileSync(
        outbox,
        readFileSync(outbox, "utf8").split(head).join(signed),
      );
      git(checkout, ["log", "-z", COMMIT_FORMAT, "-1"]);
      assert.ok(existsSync(marker));
      rmSync(marker);
      assert.equal(await replayRun(fixture, turns), TasksExit.Success);
      assert.ok(!existsSync(marker));
      assert.equal(
        checkOf(join(fixture.root, "replay"), REPLAY_CHECK)?.passed,
        true,
      );
    },
  );

  test(
    "an --output that is the recorded folder through a symlink, or a folder inside it, fails with option_invalid",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const fixture = await seedFixture(t);
      const turns = await liveRun(
        fixture,
        scriptedProvider([writeGood(), fauxAssistantMessage("done")]),
      );
      const out = join(fixture.root, "out");
      const link = join(fixture.root, "link");
      symlinkSync(out, link);
      for (const output of [link, join(link, "nested"), join(out, "nested")]) {
        const failed = await diagnosticOf(
          replayRun(fixture, turns, {}, output),
        );
        assert.deepEqual(
          [failed.code, failed.fields],
          [TasksErrorCode.OptionInvalid, [["option", "--output"]]],
        );
      }
      assert.ok(!existsSync(join(out, "nested")));
    },
  );
});

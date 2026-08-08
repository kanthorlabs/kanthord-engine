import test from "node:test";
import assert from "node:assert/strict";

import { createSshDriver, type SshExecutor, type SshTarget } from "./ssh.ts";
import { createLedger } from "../resources.ts";
import { secrets } from "../redact.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import type { CommandRecord } from "../command.ts";

const daemonHost = "daemon.example";
const clientHost = "client.example";
const tag = "R-ssh-test";

function fakeContext(): ScenarioContext & {
  taken(): readonly { kind: string; id: string }[];
} {
  const ledger = createLedger();
  return {
    tag,
    scenarioId: "P1-E3",
    bundleDirectory: "/tmp/ssh-test-bundle",
    take: ledger.take,
    sink: { print(): void {}, record(): void {} },
    assert(): void {},
    daemonHost,
    clientHost,
    taken: ledger.taken,
  };
}

function record(
  argv: readonly string[],
  stdout: string,
  exitCode = 0,
): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode, stdout, stderr: "" };
}

type Call = Readonly<{ target: SshTarget; argv: readonly string[] }>;

function buildExecute(): Readonly<{ execute: SshExecutor; calls: Call[] }> {
  const calls: Call[] = [];
  const execute: SshExecutor = async (target, argv) => {
    calls.push({ target, argv });

    if (
      argv.includes("test") &&
      argv.includes("-e") &&
      argv.some((token) => token.includes("/etc/kanthord/config.json"))
    ) {
      return record(argv, "", 1);
    }

    return record(argv, "200\n{}");
  };
  return { execute, calls };
}

test("cli(argv) issues its command against the client host", async () => {
  const { execute, calls } = buildExecute();
  const driver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute,
  });

  await driver.cli(["--version"]);

  assert.ok(calls.length > 0, "cli must issue at least one command");
  for (const call of calls) {
    assert.equal(call.target.role, "client", "cli must target the client host");
    assert.equal(call.target.host, clientHost);
  }
});

test("every issued argv whose command is ssh carries -o BatchMode=yes and -o StrictHostKeyChecking=yes", async () => {
  const { execute, calls } = buildExecute();
  const driver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute,
  });

  await driver.cli(["--version"]);
  await driver.assertBareMachine();
  await driver.deliverToken("a-real-token-value");

  const sshCalls = calls.filter((call) => call.argv[0] === "ssh");
  assert.ok(
    sshCalls.length > 0,
    "expected at least one ssh-prefixed argv to inspect",
  );
  for (const call of sshCalls) {
    assert.ok(
      call.argv.includes("-o"),
      `${call.argv.join(" ")} carries no -o flag`,
    );
    assert.ok(
      call.argv.includes("BatchMode=yes"),
      `${call.argv.join(" ")} is missing BatchMode=yes`,
    );
    assert.ok(
      call.argv.includes("StrictHostKeyChecking=yes"),
      `${call.argv.join(" ")} is missing StrictHostKeyChecking=yes`,
    );
  }
});

test("deliverToken issues install -m 600 /dev/null <path> before writing, on both hosts", async () => {
  const { execute, calls } = buildExecute();
  const driver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute,
  });

  await driver.deliverToken("a-real-token-value");

  const installCalls = calls.filter(
    (call) =>
      call.argv.includes("install") &&
      call.argv.includes("-m") &&
      call.argv.includes("600") &&
      call.argv.includes("/dev/null"),
  );
  assert.ok(installCalls.length >= 2, "expected an install call for each host");

  const roles = installCalls.map((call) => call.target.role).sort();
  assert.deepEqual(roles, ["client", "daemon"]);

  for (const installCall of installCalls) {
    const installIndex = calls.indexOf(installCall);
    const sameHostLaterCalls = calls
      .slice(installIndex + 1)
      .filter((call) => call.target.host === installCall.target.host);
    assert.ok(
      sameHostLaterCalls.length > 0,
      `expected a write to follow the install call on ${installCall.target.host}`,
    );
  }
});

test("assertBareMachine passes when /etc/kanthord/config.json is absent, and fails when it is present", async () => {
  const { execute: bareExecute } = buildExecute();
  const bareDriver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute: bareExecute,
  });
  await assert.doesNotReject(bareDriver.assertBareMachine());

  const dirtyExecute: SshExecutor = async (_target, argv) =>
    record(argv, "present", 0);
  const dirtyDriver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute: dirtyExecute,
  });
  await assert.rejects(dirtyDriver.assertBareMachine());
});

test("no argv issued by deliverToken, cli or assertBareMachine contains the held secret value", async () => {
  const { execute, calls } = buildExecute();
  const driver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute,
  });

  const tokenValue = "a-held-secret-value-for-ssh-test";
  secrets.hold(tokenValue);

  await driver.deliverToken(tokenValue);
  await driver.cli(["--version"]);
  await driver.assertBareMachine();

  const secretForms = secrets.forms();
  for (const call of calls) {
    for (const token of call.argv) {
      assert.equal(
        secretForms.some((form) => token.includes(form)),
        false,
        `argv token ${token} discloses a held secret`,
      );
    }
  }
});

test("no issued argv deletes a remote branch: no git push .*:refs/ and no git push --delete", async () => {
  const { execute, calls } = buildExecute();
  const driver = await createSshDriver(fakeContext(), {
    daemonHost,
    clientHost,
    execute,
  });

  await driver.cli(["--version"]);
  await driver.assertBareMachine();
  await driver.deliverToken("a-real-token-value");

  const pushDeleteRefs = /git push .*:refs\//;
  const pushDeleteFlag = /git push --delete/;
  for (const call of calls) {
    const line = call.argv.join(" ");
    assert.equal(
      pushDeleteRefs.test(line),
      false,
      `${line} pushes a delete of a ref`,
    );
    assert.equal(pushDeleteFlag.test(line), false, `${line} uses --delete`);
  }
});

test("deliverBinary(role) returns the delivered kanthord binary path for the tag, and the ledger holds every host resource after a run that fails mid-journey", async () => {
  const { execute } = buildExecute();
  const context = fakeContext();
  const driver = await createSshDriver(context, {
    daemonHost,
    clientHost,
    execute,
  });

  const daemonBinary = await driver.deliverBinary("daemon");
  const clientBinary = await driver.deliverBinary("client");
  assert.equal(daemonBinary, `~/.kanthord-e2e-${tag}/bin/kanthord`);
  assert.equal(clientBinary, `~/.kanthord-e2e-${tag}/bin/kanthord`);

  const before = context.taken().length;
  await driver.deliverToken("a-real-token-value");
  await driver.deliverConfig({
    home: "~/.kanthord-e2e-home",
    actor: "e2e-p1-e3",
    masterKey: "0".repeat(32),
    http: {
      bind: "0.0.0.0",
      port: 7421,
      token: "a-real-token-value",
      allowedHosts: [`${daemonHost}:7421`],
    },
    tools: { git: "git", ssh: "ssh", sshKeyscan: "ssh-keyscan" },
    attemptLimit: 3,
  });
  await driver.startDaemon({
    home: "~/.kanthord-e2e-home",
    actor: "e2e-p1-e3",
    masterKey: "0".repeat(32),
    http: {
      bind: "0.0.0.0",
      port: 7421,
      token: "a-real-token-value",
      allowedHosts: [`${daemonHost}:7421`],
    },
    tools: { git: "git", ssh: "ssh", sshKeyscan: "ssh-keyscan" },
    attemptLimit: 3,
  });

  const rejectingExecute: SshExecutor = async () => {
    throw new Error("the journey failed mid-flight");
  };
  const failingDriver = await createSshDriver(context, {
    daemonHost,
    clientHost,
    execute: rejectingExecute,
  });
  await assert.rejects(failingDriver.cli(["status"]));

  const after = context.taken().length;
  assert.ok(
    after - before >= 4,
    "expected the token, the config and the daemon process to remain in the ledger after a later failure",
  );
});

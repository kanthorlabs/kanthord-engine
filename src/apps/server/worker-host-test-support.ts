import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { Intent } from "../../mission/contract.ts";
import type { CredentialAnswer } from "../../custody/contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { generateSshKey } from "../../repository/ssh-key.ts";
import type { TestSshd } from "../../repository/sshd-test-support.ts";
import type { RepositoryTransport } from "../../worker/contract.ts";
import { FAKE_SSH_CREDENTIAL } from "./test-support.ts";
import { workerAcceptance } from "./worker-acceptance-test-support.ts";

const FIRST_REVISION = 1;
const SECOND_REVISION = 2;

export async function fixture(t: TestContext, sshd: TestSshd) {
  const setup = await workerAcceptance(t, true, { fakeSlots: true });
  const mission = await setup.read<{ id: string }>([
    "mission",
    "get",
    setup.project_id,
  ]);
  const content = {
    name: "Greetings",
    requirement: "Write hello.txt",
    criterion: "hello.txt exists",
    verifications: ["test -f hello.txt"],
    bindings: [] as string[],
  };
  const examine = await setup.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "examine-1.md",
      content: { ...content, intent: Intent.Examine, verifications: ["true"] },
      tasks: [],
      reason: "plan",
      expected_mission_version: FIRST_REVISION,
    },
  );
  const implement = await setup.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "implement-a.md",
      content: {
        ...content,
        intent: Intent.Implement,
        bindings: [setup.bindings.repo!.id, setup.bindings.store!.id],
      },
      tasks: [{ filename: "task-a.md", content }],
      reason: "plan",
      expected_mission_version: SECOND_REVISION,
    },
  );
  const nodeId = implement.revisions[0]!.node_id;
  await setup.write(
    ["mission", "dependency", "add", examine.revisions[0]!.node_id, nodeId],
    { reason: "plan", expected_mission_version: SECOND_REVISION + 1 },
  );
  const seed = join(setup.directory, "seed");
  const bare = join(setup.directory, "bare.git");
  mkdirSync(seed, { mode: 0o700 });
  const git = simpleGit(seed);
  await git.init(false, ["--initial-branch=main"]);
  await git.addConfig("user.name", "Worker Test");
  await git.addConfig("user.email", "worker@example.invalid");
  writeFileSync(join(seed, "README.md"), "Worker acceptance\n");
  await git.add("README.md");
  await git.commit("initial");
  await git.clone(seed, bare, ["--bare"]);
  const sshKey = await setup.read<CredentialAnswer>([
    "repository",
    "credential",
    "get",
    FAKE_SSH_CREDENTIAL,
  ]);
  const publicKey = String(sshKey.revisions[0]?.metadata?.public_key);
  await sshd.authorize(publicKey);
  const handed: SshAccess[] = [];
  const localKey = generateSshKey("local");
  await sshd.authorize(localKey.public_key);
  const routed = (ssh: SshAccess): SshAccess => {
    handed.push(ssh);
    return "relay" in ssh
      ? { ...localKey, known_hosts: sshd.known_hosts, port: sshd.port }
      : { ...ssh, known_hosts: sshd.known_hosts, port: sshd.port };
  };
  const origin = sshd.url(bare);
  const connector = new RepositoryComponent();
  const transport: RepositoryTransport = {
    clone: (_address, directory, context, deadline, ssh) =>
      connector.clone(origin, directory, context, deadline, routed(ssh)),
    cloneSnapshot: (_address, revision, directory, context, deadline, ssh) =>
      connector.cloneSnapshot(
        origin,
        revision,
        directory,
        context,
        deadline,
        routed(ssh),
      ),
    refreshSnapshot: (input) =>
      connector.refreshSnapshot({
        ...input,
        address: origin,
        ssh: routed(input.ssh),
      }),
    fetchAndCheckout: async (
      directory,
      branch,
      base,
      pushed,
      keep,
      record,
      context,
      deadline,
      ssh,
    ) => {
      await simpleGit(directory).remote(["set-url", "origin", origin]);
      return connector.fetchAndCheckout(
        directory,
        branch,
        base,
        pushed,
        keep,
        record,
        context,
        deadline,
        routed(ssh),
      );
    },
    fetchBase: (directory, base, context, deadline, ssh) =>
      connector.fetchBase(directory, base, context, deadline, routed(ssh)),
    pushNodeBranch: (directory, branch, context, deadline, ssh) =>
      connector.pushNodeBranch(
        directory,
        branch,
        context,
        deadline,
        routed(ssh),
      ),
  };
  const auth = await setup.fixture.slotClient(setup.project_id, "general");
  assert.ok(nodeId);
  assert.ok(auth.client_secret);
  return {
    ...setup,
    node_id: nodeId,
    bare,
    git,
    auth,
    transport,
    handed,
    publicKey,
  };
}

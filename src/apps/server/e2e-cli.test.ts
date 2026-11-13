import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NAMES } from "../../agent/contract.ts";
import {
  Consumer,
  InboundKind,
  InboundPlatform,
  ResourceKind,
} from "../../intake/contract.ts";
import { IdentityKind } from "../../kernel/caller.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  InboxItemState,
  InboxReason,
  NodeState,
} from "../../mission/contract.ts";
import { packageVersion } from "../../kernel/version.ts";
import {
  cliSession,
  createCredentials,
  environment,
  spawnKanthord,
} from "./cli-test-support.ts";
import { fakeGitHub, gatewayFixture } from "./test-support.ts";

const EXIT_SUCCESS = 0;
const NO_OUTPUT = "";
const VERSION = "--version";
const EXIT_FAILURE = 1;
const CONFIG_NOT_FOUND = "system.config.not_found";
const SERVE = "serve";
const NOT_FOUND = -1;
const NO_COMMANDS = 0;
const HELP = "--help";
const COMMANDS_HEADER = "Commands:";
const COMMAND_ROW = /^ {2}(\S+)(?:\s|$)/gm;

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
  assert.ok(names.length > NO_COMMANDS, stdout);
  return names;
}

test("the real process prints help and the package version", async (t) => {
  const env = environment(temporary(t));
  const help = await spawnKanthord([HELP], env, t.signal);
  assert.equal(help.code, EXIT_SUCCESS, help.stderr);
  assert.ok(commandNames(help.stdout).includes(SERVE));
  const version = await spawnKanthord([VERSION], env, t.signal);
  assert.equal(version.code, EXIT_SUCCESS, version.stderr);
  assert.equal(version.stdout, `${packageVersion()}\n`);
});

test("the real process exits with the failure code of a failed command", async (t) => {
  const env = environment(temporary(t));
  const result = await spawnKanthord(["config", "validate"], env, t.signal);
  assert.equal(result.code, EXIT_FAILURE);
  assert.equal(result.stdout, NO_OUTPUT);
  assert.ok(result.stderr.startsWith(`${CONFIG_NOT_FOUND}:`), result.stderr);
});

test("the real process sends an authenticated request to the server", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const result = await spawnKanthord(["gateway", "verify"], env, t.signal);
  assert.equal(result.code, EXIT_SUCCESS, result.stderr);
  assert.equal(result.stderr, NO_OUTPUT);
  assert.equal(
    (JSON.parse(result.stdout) as { kind: string }).kind,
    IdentityKind.Human,
  );
});

const LINK_MARKER = "link-update-marker";
const TRUSTED_ACTOR = "9";
const OTHER_ACTOR = "7";
const FIRST_BINDING_SET = 1;
const FIRST_ITEM = 0;
const NO_ATTEMPT = 0;
const FIRST_REVISION = 1;
const CONVERSATION_BINDING = "conversation";
const CONVERSATION_REPOSITORY = "acme/app";
const LINK = {
  kind: "github_issue",
  resource_identity: `conversation:github:${CONVERSATION_REPOSITORY}`,
  number: 7,
};
const FIRST_OCCURRED_AT = 1700000001000;
const SECOND_OCCURRED_AT = 1700000002000;

test("kanthord mission link-update list prints the rows of the trusted actors of a node", async (t) => {
  const fixture = await gatewayFixture(t);
  const session = cliSession(t, fixture.endpoint, fixture.token, LINK_MARKER);
  await createCredentials(session, LINK_MARKER);
  const project = await session.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "links",
  ]);
  const mission = await session.read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  await session.write(["project", "binding", "apply", project.id], {
    version: FIRST_BINDING_SET,
    bindings: {
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: 1 },
      },
      [CONVERSATION_BINDING]: {
        kind: "conversation",
        config: {
          available: true,
          platform: "github",
          repository: CONVERSATION_REPOSITORY,
          credential: "github",
          link_trust: { actor_ids: [TRUSTED_ACTOR] },
        },
      },
    },
  });
  const bindings = await session.read<{
    items: { id: string; name: string }[];
  }>(["project", "binding", "list", project.id]);
  const binding = bindings.items.find(
    (item) => item.name === CONVERSATION_BINDING,
  );
  assert.ok(binding);
  const created = await session.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "link.md",
      content: {
        name: "Follow the thread",
        requirement: "Follow the thread",
        criterion: "The thread is followed",
        verifications: ["true"],
        bindings: [binding.id],
        intent: "examine",
        external_links: [LINK],
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  const nodeId = created.revisions[FIRST_ITEM]!.node_id;
  const insert = fixture.store.database.prepare(
    "INSERT INTO mission_link_update (id, mission_id, external_link, update_key, inbound_event_id, actor_id, occurred_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [actor, occurredAt] of [
    [OTHER_ACTOR, FIRST_OCCURRED_AT],
    [TRUSTED_ACTOR, SECOND_OCCURRED_AT],
  ] as const)
    insert.run(
      createIdentity("link_update"),
      mission.id,
      canonicalJSON(LINK),
      `issue_comment:${occurredAt}`,
      createIdentity("inbound_event"),
      actor,
      occurredAt,
      InboxReason.Linked,
    );
  const page = await session.read<{
    items: { actor_id: string; external_link: unknown; new: boolean }[];
    next_cursor: string | null;
  }>(["mission", "link-update", "list", nodeId]);
  assert.deepEqual(
    page.items.map((item) => item.actor_id),
    [TRUSTED_ACTOR],
  );
  assert.deepEqual(page.items[FIRST_ITEM]?.external_link, LINK);
  assert.equal(page.items[FIRST_ITEM]?.new, true);
  assert.equal(page.next_cursor, null);
});

const INBOX_MARKER = "inbox-item-marker";
const INBOX_ACTOR = "583231";
const INBOX_HANDLE = "ulrich";
const NO_ITEMS = 0;
const ONE_ITEM = 1;

test("kanthord mission inbox-item list and done reach their routes", async (t) => {
  const fixture = await gatewayFixture(t);
  const session = cliSession(t, fixture.endpoint, fixture.token, INBOX_MARKER);
  await createCredentials(session, INBOX_MARKER);
  const project = await session.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "inbox",
  ]);
  const mission = await session.read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  await session.write(["project", "binding", "apply", project.id], {
    version: FIRST_BINDING_SET,
    bindings: {
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: 1 },
      },
      [CONVERSATION_BINDING]: {
        kind: "conversation",
        config: {
          available: true,
          platform: "github",
          repository: CONVERSATION_REPOSITORY,
          credential: "github",
          link_trust: { actor_ids: [TRUSTED_ACTOR] },
          inbox: { actor_id: INBOX_ACTOR, handle: INBOX_HANDLE },
        },
      },
    },
  });
  const bindings = await session.read<{
    items: { id: string; name: string }[];
  }>(["project", "binding", "list", project.id]);
  const binding = bindings.items.find(
    (item) => item.name === CONVERSATION_BINDING,
  );
  assert.ok(binding);
  const linkUpdateId = createIdentity("link_update");
  fixture.store.database
    .prepare(
      "INSERT INTO mission_link_update (id, mission_id, external_link, update_key, inbound_event_id, actor_id, occurred_at, reason, binding_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      linkUpdateId,
      mission.id,
      canonicalJSON(LINK),
      `issue_comment:${FIRST_OCCURRED_AT}`,
      createIdentity("inbound_event"),
      TRUSTED_ACTOR,
      FIRST_OCCURRED_AT,
      InboxReason.Mentioned,
      binding.id,
    );
  type Listed = {
    items: {
      link_update_id: string;
      state: string;
      reason: string;
      trusted: boolean;
      content: unknown;
    }[];
    counts: { open: number; snoozed: number };
  };
  const listed = await session.read<Listed>([
    "mission",
    "inbox-item",
    "list",
    "--project",
    project.id,
  ]);
  assert.equal(listed.items.length, ONE_ITEM);
  assert.equal(listed.items[FIRST_ITEM]?.link_update_id, linkUpdateId);
  assert.equal(listed.items[FIRST_ITEM]?.state, InboxItemState.Open);
  assert.equal(listed.items[FIRST_ITEM]?.reason, InboxReason.Mentioned);
  assert.equal(listed.items[FIRST_ITEM]?.trusted, true);
  assert.equal(listed.items[FIRST_ITEM]?.content, null);
  assert.deepEqual(listed.counts, { open: ONE_ITEM, snoozed: NO_ITEMS });
  const done = await session.write<{ state: string }>(
    ["mission", "inbox-item", "done", linkUpdateId],
    { snoozed_until: null },
  );
  assert.equal(done.state, InboxItemState.Done);
  const closed = await session.read<Listed>([
    "mission",
    "inbox-item",
    "list",
    "--state",
    InboxItemState.Done,
  ]);
  assert.equal(closed.items.length, ONE_ITEM);
  const reopened = await session.read<Listed>([
    "mission",
    "inbox-item",
    "list",
    "--project",
    project.id,
  ]);
  assert.equal(reopened.items.length, NO_ITEMS);
});

const FOLLOWUP_MARKER = "followup-marker";

test("kanthord mission followup list and decide reach their routes", async (t) => {
  const fixture = await gatewayFixture(t);
  const session = cliSession(
    t,
    fixture.endpoint,
    fixture.token,
    FOLLOWUP_MARKER,
  );
  await createCredentials(session, FOLLOWUP_MARKER);
  const project = await session.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "followups",
  ]);
  const mission = await session.read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  await session.write(["project", "binding", "apply", project.id], {
    version: FIRST_BINDING_SET,
    bindings: {
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: 1 },
      },
    },
  });
  const created = await session.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "origin.md",
      content: {
        name: "Origin",
        requirement: "Origin requirement",
        criterion: "Origin criterion",
        verifications: ["true"],
        bindings: [],
        intent: "examine",
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  const nodeId = created.revisions[FIRST_ITEM]!.node_id;
  const proposalId = createIdentity("proposal");
  fixture.store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, nodeId);
  fixture.store.database
    .prepare(
      "INSERT INTO mission_proposal (id, node_id, attempt, assessment_id, content, created_node_id, approved_at, rejected_at, created_at) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)",
    )
    .run(
      proposalId,
      nodeId,
      NO_ATTEMPT,
      canonicalJSON({ node_revision: FIRST_REVISION }),
      FIRST_OCCURRED_AT,
    );
  const listed = await session.read<{
    items: { id: string; node_id: string; assessment_id: string | null }[];
  }>(["mission", "followup", "list", project.id]);
  assert.deepEqual(
    listed.items.map((item) => [item.id, item.node_id, item.assessment_id]),
    [[proposalId, nodeId, null]],
  );
  const current = await session.read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  const decided = await session.write<{
    id: string;
    created_node_id: string | null;
  }>(["mission", "followup", "decide", nodeId], {
    expected_mission_version: current.version,
    approve: true,
    requirement: "Follow-up requirement",
  });
  assert.equal(decided.id, proposalId);
  assert.match(String(decided.created_node_id), /^node_/);
  const after = await session.read<{ items: unknown[] }>([
    "mission",
    "followup",
    "list",
    project.id,
  ]);
  assert.deepEqual(after.items, []);
});

const CHECK_MARKER = "node-check-link-marker";
const COMMENT_ID = 4401;
const COMMENT_CREATED_AT = "2026-11-07T04:00:00Z";

test("kanthord mission node check prints the link counts", async (t) => {
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
  });
  const session = cliSession(t, fixture.endpoint, fixture.token, CHECK_MARKER);
  await createCredentials(session, CHECK_MARKER);
  const project = await session.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "check-links",
  ]);
  const mission = await session.read<{ id: string; version: number }>([
    "mission",
    "get",
    project.id,
  ]);
  await session.write(["project", "binding", "apply", project.id], {
    version: FIRST_BINDING_SET,
    bindings: {
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: 1 },
      },
      [CONVERSATION_BINDING]: {
        kind: "conversation",
        config: {
          available: true,
          platform: "github",
          repository: CONVERSATION_REPOSITORY,
          credential: "github",
        },
      },
    },
  });
  const bindings = await session.read<{
    items: { id: string; name: string }[];
  }>(["project", "binding", "list", project.id]);
  const binding = bindings.items.find(
    (item) => item.name === CONVERSATION_BINDING,
  );
  assert.ok(binding);
  const created = await session.write<{ revisions: { node_id: string }[] }>(
    ["mission", "node", "create", mission.id],
    {
      filename: "link.md",
      content: {
        name: "Follow the thread",
        requirement: "Follow the thread",
        criterion: "The thread is followed",
        verifications: ["true"],
        bindings: [binding.id],
        intent: "examine",
        external_links: [LINK],
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: mission.version,
    },
  );
  const nodeId = created.revisions[FIRST_ITEM]!.node_id;
  const [owner, repository] = CONVERSATION_REPOSITORY.split("/");
  gitHub.issueComments(owner!, repository!, [
    {
      id: COMMENT_ID,
      user: { id: Number(OTHER_ACTOR), login: "reviewer", type: "User" },
      body: "Please update the plan.",
      created_at: COMMENT_CREATED_AT,
      html_url: `https://github.com/${CONVERSATION_REPOSITORY}/issues/${LINK.number}#issuecomment-${COMMENT_ID}`,
      issue_url: `https://api.github.com/repos/${CONVERSATION_REPOSITORY}/issues/${LINK.number}`,
      performed_via_github_app: null,
    },
  ]);
  const check = async () => {
    const current = await session.read<{ version: number }>([
      "mission",
      "get",
      project.id,
    ]);
    return session.write<{
      results: unknown[];
      failures: unknown[];
      link_updates: {
        external_link: unknown;
        admitted: number;
        duplicate: number;
        refused: number;
      }[];
    }>(["mission", "node", "check", nodeId], {
      expected_mission_version: current.version,
    });
  };
  await session.write(["intake", "inbound", "create"], {
    project_id: project.id,
    kind: InboundKind.Webhook,
    platform: InboundPlatform.GitHub,
    consumer: Consumer.MissionDeliveryAdmit,
    configuration: {
      resource_kind: ResourceKind.Conversation,
      resource: CONVERSATION_REPOSITORY,
    },
  });
  const first = await check();
  assert.deepEqual(first.link_updates, [
    {
      external_link: LINK,
      admitted: ONE_ITEM,
      duplicate: NO_ITEMS,
      refused: NO_ITEMS,
    },
  ]);
  const second = await check();
  assert.deepEqual(second.link_updates, [
    {
      external_link: LINK,
      admitted: NO_ITEMS,
      duplicate: ONE_ITEM,
      refused: NO_ITEMS,
    },
  ]);
});

test("(happy path) kanthord agent list prints every catalog agent", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const result = await spawnKanthord(["agent", "list"], env, t.signal);
  assert.equal(result.code, EXIT_SUCCESS, result.stderr);
  const answer = JSON.parse(result.stdout) as {
    items: { agent_name: string }[];
  };
  assert.deepEqual(
    answer.items.map(({ agent_name }) => agent_name),
    [...AGENT_NAMES].sort(),
  );
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { agentOperations } from "../agent/contract.ts";
import { missionOperations } from "../mission/contract.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { background } from "../kernel/context.ts";
import {
  WORKBENCH_INVITE_LIFETIME_MS,
  WORKBENCH_SERVICE_NAME,
  WORKBENCH_SESSION_PREFIX,
  WorkbenchErrorCode,
  workbenchOperations,
} from "./contract.ts";
import { liveGrant } from "./guard.ts";
import { WorkbenchInvites } from "./invites.ts";
import { workbenchMigrations } from "./migrations.ts";
import {
  type Dependencies,
  type GuestTokenRequest,
  WorkbenchService,
} from "./service.ts";

const OWNER = "kanthord";
const HOST_AGENT = "ops@1";
const PROJECT = createIdentity("project");
const OTHER_PROJECT = createIdentity("project");
const GUEST_NAME = "Mira";
const OTHER_GUEST_NAME = "Noor";
const PROJECT_NAME = "alpha";
const SIGNED_TOKEN = "signed-guest-token";
const BLANK = "  \t ";
const LONG_NAME = "n".repeat(65);
const NO_ITEMS = 0;
const SINGLE = 1;

const caller: CallerContext = {
  identity: testHumanIdentity(OWNER, "Ulrich", "invites"),
  context: background,
  requestId: "request",
  commit: () => {
    throw new Error("The invite handlers commit through the store.");
  },
};

interface HeldSession {
  id: string;
  hostId: string | null;
  agentName: string;
  evidenceGrants: Set<string>;
}

function fixture(t: TestContext) {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
  ]);
  const invites = new WorkbenchInvites(
    store,
    (ids) =>
      new Map(
        ids
          .filter((id) => id === PROJECT || id === OTHER_PROJECT)
          .map((id) => [id, PROJECT_NAME]),
      ),
  );
  const signed: GuestTokenRequest[] = [];
  const service = new WorkbenchService({
    store,
    invites,
    stateDirectory: temporary(t),
    signGuestToken: async (guest: GuestTokenRequest) => {
      signed.push(guest);
      return { token: SIGNED_TOKEN };
    },
  } as unknown as Dependencies);
  const held = (service as unknown as { sessions: Map<string, HeldSession> })
    .sessions;
  const host = (): HeldSession => {
    const session = {
      id: createIdentity(WORKBENCH_SESSION_PREFIX),
      hostId: null,
      agentName: HOST_AGENT,
      evidenceGrants: new Set<string>(),
    };
    held.set(session.id, session);
    return session;
  };
  const participantOf = (hostId: string): HeldSession => {
    const session = {
      id: createIdentity(WORKBENCH_SESSION_PREFIX),
      hostId,
      agentName: HOST_AGENT,
      evidenceGrants: new Set<string>(),
    };
    held.set(session.id, session);
    return session;
  };
  const rows = () =>
    store.transaction((tx) =>
      tx.database.prepare("SELECT * FROM workbench_invite").all(),
    );
  const expireAll = () =>
    store.transaction((tx) =>
      tx.database
        .prepare("UPDATE workbench_invite SET expires_at = ?")
        .run(Date.now() - SINGLE),
    );
  return {
    store,
    invites,
    service,
    signed,
    host,
    participantOf,
    rows,
    expireAll,
  };
}

async function refusedWith(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  await assert.rejects(
    work,
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

test("(security, redaction) token_hash is the SHA-256 of the token, and the raw token appears in no row and in no idempotency record", async (t) => {
  const f = fixture(t);
  const host = f.host();
  const created = await f.service.inviteCreate(caller, host.id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [],
  });
  const [row] = f.rows() as Record<string, unknown>[];
  assert.ok(row);
  assert.equal(f.rows().length, SINGLE);
  assert.equal(
    row.token_hash,
    createHash("sha256").update(created.invite_token).digest("hex"),
  );
  assert.equal(row.id, created.id);
  assert.equal(row.session_id, host.id);
  assert.equal(row.invited_by, OWNER);
  assert.equal(row.invitee_name, GUEST_NAME);
  assert.equal((row.expires_at! as number) - created.expires_at, NO_ITEMS);
  assert.ok(
    created.expires_at - Date.now() <= WORKBENCH_INVITE_LIFETIME_MS &&
      created.expires_at - Date.now() > WORKBENCH_INVITE_LIFETIME_MS / 2,
  );
  assert.ok(!JSON.stringify(f.rows()).includes(created.invite_token));
  assert.equal(workbenchOperations["invite.create"].secret, true);
});

test("(security, refused path) join with an unknown token answers 404 workbench.invite.not_found", async (t) => {
  const f = fixture(t);
  await refusedWith(
    f.service.inviteJoin({ invite_token: randomUUID(), name: GUEST_NAME }),
    HttpStatus.NotFound,
    WorkbenchErrorCode.InviteNotFound,
  );
  assert.deepEqual(f.signed, []);
});

test("(security, refused path) join with the token of an expired row answers 404 workbench.invite.not_found and signs no guest token", async (t) => {
  const f = fixture(t);
  const created = await f.service.inviteCreate(caller, f.host().id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [],
  });
  f.expireAll();
  await refusedWith(
    f.service.inviteJoin({
      invite_token: created.invite_token,
      name: GUEST_NAME,
    }),
    HttpStatus.NotFound,
    WorkbenchErrorCode.InviteNotFound,
  );
  assert.deepEqual(f.signed, []);
});

test("(security, argument guard) a blank or 65-character name at join answers 400 workbench.invite.name_invalid", async (t) => {
  const f = fixture(t);
  const created = await f.service.inviteCreate(caller, f.host().id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [],
  });
  for (const name of [BLANK, LONG_NAME])
    await refusedWith(
      f.service.inviteJoin({ invite_token: created.invite_token, name }),
      HttpStatus.BadRequest,
      WorkbenchErrorCode.InviteNameInvalid,
    );
  assert.deepEqual(f.signed, []);
});

test("(security, argument guard) a blank or 65-character invitee_name at create answers 400 workbench.invite.name_invalid", async (t) => {
  const f = fixture(t);
  const host = f.host();
  for (const invitee_name of [BLANK, LONG_NAME])
    await refusedWith(
      f.service.inviteCreate(caller, host.id, {
        invitee_name,
        project_ids: [PROJECT],
        granted_operations: [],
      }),
      HttpStatus.BadRequest,
      WorkbenchErrorCode.InviteNameInvalid,
    );
  assert.deepEqual(f.rows(), []);
});

test("(security, refused path) invite.create on an unknown session answers 404 workbench.session.not_found", async (t) => {
  const f = fixture(t);
  await refusedWith(
    f.service.inviteCreate(caller, createIdentity(WORKBENCH_SESSION_PREFIX), {
      invitee_name: GUEST_NAME,
      project_ids: [PROJECT],
      granted_operations: [],
    }),
    HttpStatus.NotFound,
    WorkbenchErrorCode.SessionNotFound,
  );
  assert.deepEqual(f.rows(), []);
});

test("(security, refused path) invite.revoke on an unknown id answers 404 workbench.invite.not_found", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.service.inviteRevoke(createIdentity("workbench_invite")),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.NotFound &&
      error.code === WorkbenchErrorCode.InviteNotFound,
  );
});

test("(security, refused path) invite.create on a participant id answers 409 workbench.session.not_host", async (t) => {
  const f = fixture(t);
  const participant = f.participantOf(f.host().id);
  await refusedWith(
    f.service.inviteCreate(caller, participant.id, {
      invitee_name: GUEST_NAME,
      project_ids: [PROJECT],
      granted_operations: [],
    }),
    HttpStatus.Conflict,
    WorkbenchErrorCode.NotHost,
  );
  assert.deepEqual(f.rows(), []);
});

const CORRUPT_PROJECT_IDS = "[not json";

test("(security, argument guard) create with an unknown id and a repeated id answers 400 workbench.invite.project_invalid and lists both", async (t) => {
  const f = fixture(t);
  const host = f.host();
  const unknown = createIdentity("project");
  await assert.rejects(
    f.service.inviteCreate(caller, host.id, {
      invitee_name: GUEST_NAME,
      project_ids: [PROJECT, PROJECT, unknown],
      granted_operations: [],
    }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      error.code === WorkbenchErrorCode.ProjectInvalid &&
      JSON.stringify(error.details) === JSON.stringify([PROJECT, unknown]),
  );
  assert.deepEqual(f.rows(), []);
});

test("(security, refused path) create with a set that differs from a live invite answers 409 workbench.invite.scope_mismatch", async (t) => {
  const f = fixture(t);
  const host = f.host();
  await f.service.inviteCreate(caller, host.id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [],
  });
  await refusedWith(
    f.service.inviteCreate(caller, host.id, {
      invitee_name: OTHER_GUEST_NAME,
      project_ids: [OTHER_PROJECT],
      granted_operations: [],
    }),
    HttpStatus.Conflict,
    WorkbenchErrorCode.ScopeMismatch,
  );
  assert.equal(f.rows().length, SINGLE);
});

test("(security) a corrupt project_ids column resolves to no project", async (t) => {
  const f = fixture(t);
  const created = await f.service.inviteCreate(caller, f.host().id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [],
  });
  assert.deepEqual(f.invites.resolve(created.id)?.project_ids, [PROJECT]);
  f.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE workbench_invite SET project_ids = ?")
      .run(CORRUPT_PROJECT_IDS),
  );
  assert.deepEqual(f.invites.resolve(created.id)?.project_ids, []);
});

test("(security, argument guard) create refuses an ungrantable, an unlisted, a read and a repeated id with 400 workbench.invite.grant_invalid and lists each", async (t) => {
  const f = fixture(t);
  const host = f.host();
  const pause = missionOperations["node.pause"].id;
  const unlisted = [
    missionOperations["import.apply"].id,
    agentOperations["cooldown.clear"].id,
    missionOperations["node.get"].id,
    missionOperations["node.discard"].id,
  ];
  const refused = [...unlisted, pause];
  await assert.rejects(
    f.service.inviteCreate(caller, host.id, {
      invitee_name: GUEST_NAME,
      project_ids: [PROJECT],
      granted_operations: [...unlisted, pause, pause],
    }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      error.code === WorkbenchErrorCode.GrantInvalid &&
      JSON.stringify(error.details) === JSON.stringify(refused),
  );
  assert.deepEqual(f.rows(), []);
});

test("create stores the granted ids sorted", async (t) => {
  const f = fixture(t);
  const resume = missionOperations["node.resume"].id;
  const pause = missionOperations["node.pause"].id;
  const created = await f.service.inviteCreate(caller, f.host().id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [resume, pause],
  });
  assert.deepEqual(created.granted_operations, [pause, resume]);
  assert.deepEqual(f.invites.resolve(created.id)?.granted_operations, [
    pause,
    resume,
  ]);
});

test("(security) a row with an invalid granted_operations value gives an empty live grant", async (t) => {
  const f = fixture(t);
  const created = await f.service.inviteCreate(caller, f.host().id, {
    invitee_name: GUEST_NAME,
    project_ids: [PROJECT],
    granted_operations: [missionOperations["node.pause"].id],
  });
  for (const invalid of ["[not json", "[1]", '{"a":1}']) {
    f.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE workbench_invite SET granted_operations = ?")
        .run(invalid),
    );
    const stored = f.invites.resolve(created.id)?.granted_operations;
    assert.deepEqual(stored, []);
    assert.equal(liveGrant(stored ?? [], HOST_AGENT).size, NO_ITEMS);
  }
});

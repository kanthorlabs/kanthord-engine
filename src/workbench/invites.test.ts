import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
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
} from "./contract.ts";
import { WorkbenchInvites } from "./invites.ts";
import { workbenchMigrations } from "./migrations.ts";
import {
  type Dependencies,
  type GuestTokenRequest,
  WorkbenchService,
} from "./service.ts";

const OWNER = "kanthord";
const GUEST_NAME = "Mira";
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
  evidenceGrants: Set<string>;
}

function fixture(t: TestContext) {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
  ]);
  const invites = new WorkbenchInvites(store);
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
      evidenceGrants: new Set<string>(),
    };
    held.set(session.id, session);
    return session;
  };
  const participantOf = (hostId: string): HeldSession => {
    const session = {
      id: createIdentity(WORKBENCH_SESSION_PREFIX),
      hostId,
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

test("(security, redaction) token_hash is the SHA-256 of the token, and the raw token appears in no row", async (t) => {
  const f = fixture(t);
  const host = f.host();
  const created = await f.service.inviteCreate(caller, host.id, {
    invitee_name: GUEST_NAME,
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
      f.service.inviteCreate(caller, host.id, { invitee_name }),
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
    }),
    HttpStatus.Conflict,
    WorkbenchErrorCode.NotHost,
  );
  assert.deepEqual(f.rows(), []);
});

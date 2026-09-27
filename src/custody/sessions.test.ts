import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  LoginSessionMode,
  LoginSessionState,
  LoginSessionStore,
  SESSION_EXPIRY_MS,
} from "./sessions.ts";

const NOW = 1_000_000;
const PLATFORM = "github-copilot";
const HUMAN = "alice";
const NAME = "copilot";
const PENDING_CODE = "credential.login.pending";
const FAILURE_REASON = "denied";
const LOGIN_ADDRESS = "https://example.com/login";
const DEVICE_CODE = "ABCD";
const PROGRESS_MESSAGE = "Waiting for approval";

function start(store: LoginSessionStore, now = NOW) {
  return store.start(PLATFORM, LoginSessionMode.Browser, HUMAN, NAME, now);
}

test("start creates a pending session with a login session identity and expiry", () => {
  const store = new LoginSessionStore();
  const session = start(store);

  assert.match(session.id, /^login_session_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(session.expiresAt, NOW + SESSION_EXPIRY_MS);
  assert.equal(session.state, LoginSessionState.Pending);
  assert.equal(session.platform, PLATFORM);
  assert.equal(session.mode, LoginSessionMode.Browser);
  assert.equal(session.humanIdentity, HUMAN);
  assert.equal(session.credentialName, NAME);
  assert.equal(session.address, null);
  assert.equal(session.code, null);
  assert.equal(session.lastMessage, null);
  assert.equal(session.failureReason, null);
});

test("start rejects a non-expired pending session for the same platform and human", () => {
  const store = new LoginSessionStore();
  start(store);

  assert.throws(
    () => start(store, NOW + SESSION_EXPIRY_MS - 1),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === PENDING_CODE &&
      error.status === HttpStatus.Conflict,
  );
});

test("start permits a pending session once its expiry time is reached", () => {
  const store = new LoginSessionStore();
  const previous = start(store);
  const next = start(store, previous.expiresAt);

  assert.notEqual(next.id, previous.id);
  assert.equal(next.state, LoginSessionState.Pending);
});

test("completed and failed sessions do not block a new start", () => {
  const store = new LoginSessionStore();
  const completed = start(store);
  store.complete(completed.id);
  const failed = start(store);
  store.fail(failed.id, "login failed");
  const next = start(store);

  assert.notEqual(next.id, completed.id);
  assert.notEqual(next.id, failed.id);
  assert.equal(next.state, LoginSessionState.Pending);
});

test("different humans and platforms have separate pending sessions", () => {
  const store = new LoginSessionStore();
  const first = start(store);
  const otherHuman = store.start(
    PLATFORM,
    LoginSessionMode.Device,
    "bob",
    NAME,
    NOW,
  );
  const otherPlatform = store.start(
    "other",
    LoginSessionMode.Browser,
    HUMAN,
    NAME,
    NOW,
  );

  assert.notEqual(first.id, otherHuman.id);
  assert.notEqual(first.id, otherPlatform.id);
});

test("get returns a known session and undefined for an unknown id", () => {
  const store = new LoginSessionStore();
  const session = start(store);

  assert.equal(store.get(session.id), session);
  assert.equal(store.get("unknown"), undefined);
});

test("complete, fail with reason, and expire set session state", () => {
  const store = new LoginSessionStore();
  const completed = start(store);
  store.complete(completed.id);
  const failed = start(store);
  store.fail(failed.id, FAILURE_REASON);
  const expired = start(store);
  store.expire(expired.id);

  assert.equal(completed.state, LoginSessionState.Completed);
  assert.equal(failed.state, LoginSessionState.Failed);
  assert.equal(failed.failureReason, FAILURE_REASON);
  assert.equal(expired.state, LoginSessionState.Expired);
});

test("updateAddress sets address and code", () => {
  const store = new LoginSessionStore();
  const session = start(store);
  store.updateAddress(session.id, LOGIN_ADDRESS, DEVICE_CODE);

  assert.equal(session.address, LOGIN_ADDRESS);
  assert.equal(session.code, DEVICE_CODE);
  store.updateAddress(session.id, null, null);
  assert.equal(session.address, null);
  assert.equal(session.code, null);
});

test("updateLastMessage sets lastMessage", () => {
  const store = new LoginSessionStore();
  const session = start(store);
  store.updateLastMessage(session.id, PROGRESS_MESSAGE);

  assert.equal(session.lastMessage, PROGRESS_MESSAGE);
});

test("pendingForPlatformAndHuman returns only non-expired pending sessions", () => {
  const store = new LoginSessionStore();
  const session = start(store);

  assert.equal(store.pendingForPlatformAndHuman(PLATFORM, HUMAN, NOW), session);
  assert.equal(
    store.pendingForPlatformAndHuman(PLATFORM, HUMAN, session.expiresAt),
    undefined,
  );
  assert.equal(
    store.pendingForPlatformAndHuman(PLATFORM, "bob", NOW),
    undefined,
  );
  assert.equal(
    store.pendingForPlatformAndHuman("other", HUMAN, NOW),
    undefined,
  );
});

test("mutators on an unknown id are no-ops", () => {
  const store = new LoginSessionStore();
  const session = start(store);

  store.complete("unknown");
  store.fail("unknown", "denied");
  store.expire("unknown");
  store.updateAddress("unknown", "https://example.com", "ABCD");
  store.updateLastMessage("unknown", "waiting");
  assert.equal(session.state, LoginSessionState.Pending);
  assert.equal(session.address, null);
  assert.equal(session.lastMessage, null);
});

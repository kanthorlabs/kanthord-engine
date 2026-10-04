import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";

export const LoginSessionState = {
  Pending: "pending",
  Completed: "completed",
  Failed: "failed",
  Expired: "expired",
} as const;
export type LoginSessionState =
  (typeof LoginSessionState)[keyof typeof LoginSessionState];

export { LoginSessionMode } from "./contract.ts";

export const SESSION_EXPIRY_MS = 15 * 60 * 1000;
const LOGIN_PENDING_CODE = "credential.login.pending";

export interface LoginSession {
  id: string;
  platform: string;
  mode: string;
  humanIdentity: string;
  credentialName: string;
  state: LoginSessionState;
  address: string | null;
  code: string | null;
  lastMessage: string | null;
  failureReason: string | null;
  expiresAt: number;
}

export class LoginSessionStore {
  private readonly sessions = new Map<string, LoginSession>();

  start(
    platform: string,
    mode: string,
    humanIdentity: string,
    credentialName: string,
    now: number,
  ): LoginSession {
    if (this.pendingForPlatformAndHuman(platform, humanIdentity, now)) {
      throw new OperationError(
        HttpStatus.Conflict,
        LOGIN_PENDING_CODE,
        "A login session is already pending for this platform and human.",
      );
    }

    const session: LoginSession = {
      id: createIdentity("login_session"),
      platform,
      mode,
      humanIdentity,
      credentialName,
      state: LoginSessionState.Pending,
      address: null,
      code: null,
      lastMessage: null,
      failureReason: null,
      expiresAt: now + SESSION_EXPIRY_MS,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): LoginSession | undefined {
    return this.sessions.get(id);
  }

  pendingForPlatformAndHuman(
    platform: string,
    humanIdentity: string,
    now: number,
  ): LoginSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.platform === platform &&
        session.humanIdentity === humanIdentity &&
        session.state === LoginSessionState.Pending &&
        session.expiresAt > now
      ) {
        return session;
      }
    }
    return undefined;
  }

  complete(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.state = LoginSessionState.Completed;
    }
  }

  fail(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.state = LoginSessionState.Failed;
      session.failureReason = reason;
    }
  }

  expire(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.state = LoginSessionState.Expired;
    }
  }

  updateAddress(id: string, address: string | null, code: string | null): void {
    const session = this.sessions.get(id);
    if (session) {
      session.address = address;
      session.code = code;
    }
  }

  updateLastMessage(id: string, message: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastMessage = message;
    }
  }
}

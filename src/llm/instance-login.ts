import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { SealedCopy } from "../custody/contract.ts";
import {
  InstanceLoginState,
  type LoginReportBody,
  type LoginSessionEntry,
} from "./contract.ts";
import {
  LOGIN_VALUE_NOT_AWAITED,
  loginFailed,
  loginNotFound,
} from "./login.ts";
import {
  LoginSessionMode,
  LoginSessionState,
  type LoginSession,
  type LoginSessionStore,
} from "./sessions.ts";

const INVALID_INPUT = "credential.input.invalid";
const LOGIN_FAILED = "login failed";

function invalidReport(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    INVALID_INPUT,
    "Invalid input.",
  );
}

export class InstanceLogin {
  readonly ready = Promise.withResolvers<void>();
  failure: OperationError = loginFailed();
  readonly session: LoginSession;
  private readonly sessions: LoginSessionStore;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;

  constructor(
    session: LoginSession,
    sessions: LoginSessionStore,
    now: () => number,
  ) {
    this.session = session;
    this.sessions = sessions;
    this.now = now;
  }

  arm(): void {
    this.timer = setTimeout(
      () => this.expire(),
      this.session.expires_at - this.now(),
    );
    this.timer.unref();
  }

  pending(): boolean {
    if (this.session.expires_at <= this.now()) this.expire();
    return this.session.state === LoginSessionState.Pending;
  }

  entry(): LoginSessionEntry {
    return {
      session_id: this.session.id,
      name: this.session.credential_name,
      platform: this.session.platform,
      mode: this.session.mode as LoginSessionEntry["mode"],
      code: this.session.submitted,
    };
  }

  expire(): void {
    if (this.session.state !== LoginSessionState.Pending) return;
    this.sessions.expire(this.session.id);
    this.failure = loginNotFound();
    this.end();
  }

  fail(reason: string): void {
    if (this.session.state !== LoginSessionState.Pending) return;
    this.sessions.fail(this.session.id, reason);
    this.failure = loginFailed();
    this.end();
  }

  supply(value: string): void {
    if (
      !this.pending() ||
      this.session.mode !== LoginSessionMode.CopyCode ||
      this.session.address === null ||
      this.session.submitted !== null
    )
      throw new OperationError(
        HttpStatus.Conflict,
        LOGIN_VALUE_NOT_AWAITED,
        "No login value is awaited.",
      );
    this.sessions.submit(this.session.id, value);
  }

  requirePending(): void {
    if (!this.pending()) throw loginNotFound();
  }

  report(body: LoginReportBody, write: (copy: SealedCopy) => void): boolean {
    this.requirePending();
    const sealed = body.sealed !== undefined || body.sealed_to !== undefined;
    if (body.state === InstanceLoginState.Completed) {
      if (
        body.sealed === undefined ||
        body.sealed_to === undefined ||
        this.session.address === null
      )
        throw invalidReport();
      try {
        write({
          holder: this.session.holder,
          sealed: body.sealed,
          sealed_to: body.sealed_to,
        });
      } catch (error) {
        this.fail(error instanceof OperationError ? error.code : LOGIN_FAILED);
        throw error;
      }
      return true;
    }
    if (sealed) throw invalidReport();
    if (body.state === InstanceLoginState.Failed) {
      this.fail(body.failure_reason ?? LOGIN_FAILED);
      return false;
    }
    if (body.address !== null)
      this.sessions.updateAddress(this.session.id, body.address, body.code);
    if (body.message !== null)
      this.sessions.updateLastMessage(this.session.id, body.message);
    if (this.session.address !== null) this.ready.resolve();
    return false;
  }

  complete(): void {
    this.sessions.complete(this.session.id);
    this.end();
  }

  private end(): void {
    clearTimeout(this.timer);
    this.ready.resolve();
  }
}

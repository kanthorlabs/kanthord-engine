import type { Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows as registerOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Diagnostic, OperationError } from "../../kernel/errors.ts";
import { sealJSON } from "../../kernel/hpke.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
} from "../../custody/contract.ts";
import type { InstanceCopyKey } from "../../custody/client.ts";
import {
  InstanceLoginState,
  type LoginReportBody,
  type LoginSessionEntry,
} from "../../llm/contract.ts";
import { OAuthLogin, type OAuthSecret } from "../../llm/login.ts";
import {
  LoginSessionState,
  LoginSessionStore,
  SESSION_EXPIRY_MS,
  type LoginSession,
} from "../../llm/sessions.ts";

const LOGIN_FAILED = "login failed";
const INSTANCE_HUMAN = "";
const NO_RUNNING_LOGINS = 0;

export type LoginReporter = (
  sessionId: string,
  body: LoginReportBody,
) => Promise<void>;

export interface InstanceLoginsOptions {
  key: InstanceCopyKey;
  report: LoginReporter;
  providers?: () => readonly Provider[];
  now?: () => number;
  log: (record: Record<string, unknown>) => void;
}

interface Running {
  session: LoginSession;
  flow: OAuthLogin;
  supplied: string | null;
  reported: string;
}

export class InstanceLogins {
  private readonly options: InstanceLoginsOptions;
  private readonly providers: () => readonly Provider[];
  private readonly now: () => number;
  private readonly sessions = new LoginSessionStore();
  private readonly running = new Map<string, Running>();

  constructor(options: InstanceLoginsOptions) {
    registerOAuthFlows();
    this.options = options;
    this.providers =
      options.providers ??
      (() => [
        githubCopilotProvider(),
        openaiCodexProvider(),
        anthropicProvider(),
      ]);
    this.now = options.now ?? Date.now;
  }

  pending(): boolean {
    return this.running.size > NO_RUNNING_LOGINS;
  }

  sync(entries: readonly LoginSessionEntry[]): void {
    const listed = new Set(entries.map((entry) => entry.session_id));
    for (const [id, running] of this.running)
      if (!listed.has(id)) {
        running.flow.abort();
        this.running.delete(id);
      }
    for (const entry of entries) {
      const running = this.running.get(entry.session_id) ?? this.begin(entry);
      if (running) this.advance(running, entry);
    }
  }

  stop(): void {
    for (const running of this.running.values()) running.flow.abort();
    this.running.clear();
  }

  private begin(entry: LoginSessionEntry): Running | undefined {
    if (this.sessions.get(entry.session_id)) return undefined;
    const session: LoginSession = {
      id: entry.session_id,
      platform: entry.platform,
      mode: entry.mode,
      human_identity: INSTANCE_HUMAN,
      credential_name: entry.name,
      holder: this.options.key.holder,
      state: LoginSessionState.Pending,
      address: null,
      code: null,
      last_message: null,
      failure_reason: null,
      submitted: null,
      expires_at: this.now() + SESSION_EXPIRY_MS,
    };
    this.sessions.adopt(session);
    const flow = new OAuthLogin(session, this.sessions, this.now);
    const running: Running = { session, flow, supplied: null, reported: "" };
    this.running.set(session.id, running);
    void flow.ready.promise.then(() => this.reportPending(running));
    void flow
      .run(this.providers, (secret) => this.complete(running, secret))
      .then(() => this.ended(running));
    return running;
  }

  private advance(running: Running, entry: LoginSessionEntry): void {
    if (entry.code !== null && entry.code !== running.supplied) {
      try {
        running.flow.supply(entry.code);
        running.supplied = entry.code;
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
      }
    }
    void this.reportPending(running);
  }

  private body(running: Running): LoginReportBody {
    const { session } = running;
    return {
      state: InstanceLoginState.Pending,
      address: session.address,
      code: session.code,
      message: session.last_message,
      failure_reason: null,
    };
  }

  private async reportPending(running: Running): Promise<void> {
    if (
      running.session.state !== LoginSessionState.Pending ||
      running.session.address === null
    )
      return;
    const body = this.body(running);
    const reported = JSON.stringify(body);
    if (reported === running.reported) return;
    running.reported = reported;
    await this.send(running, body);
  }

  private async complete(running: Running, secret: OAuthSecret): Promise<void> {
    const { session } = running;
    const { key } = this.options;
    const sealed = await sealJSON(
      key.public_key,
      CREDENTIAL_SEAL_INFO,
      credentialSealAad({
        name: session.credential_name,
        platform: session.platform,
        holder: key.holder,
        sealed_to: key.sealed_to,
      }),
      secret,
    );
    await this.options.report(session.id, {
      ...this.body(running),
      state: InstanceLoginState.Completed,
      sealed,
      sealed_to: key.sealed_to,
    });
    this.sessions.complete(session.id);
  }

  private async ended(running: Running): Promise<void> {
    const { session } = running;
    if (this.running.get(session.id) === running)
      this.running.delete(session.id);
    if (
      session.state !== LoginSessionState.Failed &&
      session.state !== LoginSessionState.Expired
    )
      return;
    await this.send(running, {
      ...this.body(running),
      state: InstanceLoginState.Failed,
      failure_reason: session.failure_reason ?? LOGIN_FAILED,
    });
  }

  private async send(running: Running, body: LoginReportBody): Promise<void> {
    try {
      await this.options.report(running.session.id, body);
    } catch (error) {
      this.options.log({
        msg: "Worker instance login report failed",
        session_id: running.session.id,
        code: error instanceof Diagnostic ? error.code : null,
      });
    }
  }
}

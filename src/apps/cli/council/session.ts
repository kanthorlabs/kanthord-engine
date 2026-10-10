import { CodedError, Diagnostic } from "../../../kernel/errors.ts";
import { httpClient } from "../../../gateway/client.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../../kernel/operation.ts";
import { isString } from "../../../kernel/values.ts";
import {
  workbenchOperations,
  type SessionEntry,
  type SessionEvents,
  type WorkbenchConfiguration,
} from "../../../workbench/contract.ts";
import { CouncilErrorCode } from "./contract.ts";

export const SESSION_DEADLINE_MS = 10 * 60 * 1000;
const MESSAGE_ENTRY = "message";
const ASSISTANT_ROLE = "assistant";
const EMPTY_TEXT = "";

export interface WorkbenchPort {
  create(
    agentName: string,
    configuration: WorkbenchConfiguration,
  ): Promise<string>;
  message(sessionId: string, text: string): Promise<void>;
  events(
    sessionId: string,
    version: number | undefined,
    after: string | undefined,
  ): Promise<SessionEvents>;
  entries(sessionId: string): Promise<SessionEntry[]>;
  abort(sessionId: string): Promise<void>;
}

function failed(agentName: string, reason: string): Diagnostic {
  return new Diagnostic(
    CouncilErrorCode.AgentSessionFailed,
    `${agentName}: ${reason}`,
  );
}

function lastAssistantText(
  entries: readonly SessionEntry[],
): string | undefined {
  const texts = entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; content: unknown })
    .filter((message) => message.role === ASSISTANT_ROLE)
    .map((message) =>
      isString(message.content)
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((block) => block.text ?? "")
            .join(""),
    )
    .filter((text) => text.trim() !== EMPTY_TEXT);
  return texts.at(-1);
}

async function waitForEnd(
  port: WorkbenchPort,
  agentName: string,
  sessionId: string,
  now: () => number,
): Promise<void> {
  const deadline = now() + SESSION_DEADLINE_MS;
  let version: number | undefined;
  let after: string | undefined;
  for (;;) {
    const {
      entries,
      snapshot,
      version: next,
    } = await port.events(sessionId, version, after);
    if (snapshot.error_message) throw failed(agentName, snapshot.error_message);
    if (snapshot.pending_approval)
      throw failed(agentName, "the run waits for an approval");
    if (!snapshot.run_active) return;
    if (now() >= deadline)
      throw failed(agentName, "the run did not end within 10 minutes");
    version = next;
    after = entries.at(-1)?.id ?? after;
  }
}

export async function askInSession(
  port: WorkbenchPort,
  agentName: string,
  configuration: WorkbenchConfiguration,
  text: string,
  now: () => number = Date.now,
): Promise<string> {
  let sessionId: string | undefined;
  try {
    sessionId = await port.create(agentName, configuration);
    await port.message(sessionId, text);
    await waitForEnd(port, agentName, sessionId, now);
    const answer = lastAssistantText(await port.entries(sessionId));
    if (answer === undefined)
      throw failed(agentName, "the run wrote no answer");
    return answer;
  } catch (error) {
    if (sessionId !== undefined) await port.abort(sessionId).catch(() => {});
    if (
      error instanceof CodedError &&
      error.code === CouncilErrorCode.AgentSessionFailed
    )
      throw error;
    throw failed(
      agentName,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function completed<T>(result: OperationResult<T>, operation: string): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new Error(
      `${operation} failed with ${result.error.error.code} (HTTP ${result.status})`,
    );
  throw new Error(`${operation} is indeterminate`);
}

export function httpWorkbenchPort(
  endpoint: string,
  token: string,
): WorkbenchPort {
  const client = httpClient(workbenchOperations, endpoint, token);
  return {
    async create(agentName, configuration) {
      const result = await client["session.create"]({
        params: {},
        query: {},
        body: { agent_name: agentName, ...configuration },
      });
      return completed(result, "workbench.session.create").id;
    },
    async message(sessionId, text) {
      completed(
        await client["session.message"]({
          params: { session_id: sessionId },
          query: {},
          body: { text },
        }),
        "workbench.session.message",
      );
    },
    async events(sessionId, version, after) {
      return completed(
        await client["session.events"]({
          params: { session_id: sessionId },
          query: {
            ...(version === undefined ? {} : { version }),
            ...(after === undefined ? {} : { after }),
          },
          body: null,
        }),
        "workbench.session.events",
      );
    },
    async entries(sessionId) {
      return completed(
        await client["session.get"]({
          params: { session_id: sessionId },
          query: {},
          body: null,
        }),
        "workbench.session.get",
      ).entries;
    },
    async abort(sessionId) {
      completed(
        await client["session.abort"]({
          params: { session_id: sessionId },
          query: {},
          body: null,
        }),
        "workbench.session.abort",
      );
    },
  };
}

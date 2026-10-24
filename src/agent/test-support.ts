import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  createFauxCore,
  createProvider,
  envApiKeyAuth,
  getCurrentTools,
  getSystemMessageText,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type StreamFunction,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import pino from "pino";
import type {
  CredentialHold,
  CredentialHoldItem,
  CredentialHolds,
} from "../custody/contract.ts";
import type { Transaction } from "../kernel/store.ts";

export function scriptedProvider(
  script: FauxResponseStep[],
  options: {
    providerId: string;
    modelIdentifier: string;
    models?: { id: string; reasoning: boolean }[];
  } = { providerId: "anthropic", modelIdentifier: "claude-sonnet-4-5" },
) {
  assert.ok(options.providerId);
  assert.ok(options.modelIdentifier);
  const tools: string[][] = [];
  const calls: {
    systemPrompt: ModelContext["systemPrompt"];
    messages: ModelContext["messages"];
    apiKey: string | undefined;
  }[] = [];
  const core = createFauxCore({
    provider: options.providerId,
    models: options.models ?? [
      { id: options.modelIdentifier, reasoning: false },
    ],
  });
  const record =
    (
      stream: StreamFunction<string, SimpleStreamOptions>,
    ): StreamFunction<string, SimpleStreamOptions> =>
    (model, context, streamOptions) => {
      const systemRole = "system";
      const leading = context.messages[0];
      const systemPrompt =
        leading?.role === systemRole
          ? getSystemMessageText(leading)
          : undefined;
      tools.push(getCurrentTools(context.messages).map(({ name }) => name));
      calls.push({
        systemPrompt,
        messages: structuredClone(context.messages),
        apiKey: streamOptions?.apiKey,
      });
      return stream(model, context, streamOptions);
    };
  const provider = createProvider({
    id: options.providerId,
    auth: { apiKey: envApiKeyAuth("scripted API key", []) },
    models: core.models,
    api: {
      stream: record(core.stream),
      streamSimple: record(core.streamSimple),
    },
  });
  core.setResponses(script);
  return { provider, calls, tools };
}
export type ScriptedProvider = ReturnType<typeof scriptedProvider>;

const NO_STRIKES = 0;
const NO_ROWS = 0;

function holdTable(tx: Transaction) {
  tx.database.exec(
    "CREATE TABLE IF NOT EXISTS memory_credential_hold (credential TEXT NOT NULL, holder TEXT NOT NULL, available_at INTEGER NOT NULL, strikes INTEGER NOT NULL, PRIMARY KEY (credential, holder))",
  );
  return tx.database;
}

export function memoryCredentialHolds(): CredentialHolds {
  return {
    holdOf: (tx, name, holder) => {
      const row = holdTable(tx)
        .prepare(
          "SELECT available_at, strikes FROM memory_credential_hold WHERE credential = ? AND holder = ?",
        )
        .get(name, holder) as CredentialHold | undefined;
      return row === undefined ? null : { ...row };
    },
    hold: (tx, name, holder, availableAt, strikes) => {
      holdTable(tx)
        .prepare(
          "INSERT OR REPLACE INTO memory_credential_hold (credential, holder, available_at, strikes) VALUES (?, ?, ?, ?)",
        )
        .run(name, holder, availableAt, strikes);
    },
    release: (tx, name, holder) =>
      holdTable(tx)
        .prepare(
          "DELETE FROM memory_credential_hold WHERE credential = ? AND holder = ? AND strikes > ?",
        )
        .run(name, holder, NO_STRIKES).changes > NO_ROWS,
    listHolds: (tx) =>
      holdTable(tx)
        .prepare(
          "SELECT credential, holder, available_at, strikes FROM memory_credential_hold WHERE strikes > ? ORDER BY credential, holder",
        )
        .all(NO_STRIKES)
        .map((row) => ({ ...row }) as CredentialHoldItem),
  };
}

export const FallbackLog = {
  CooldownStarted: "agent.fallback.cooldown_started",
  CooldownCleared: "agent.fallback.cooldown_cleared",
  Selected: "agent.fallback.selected",
} as const;

type CapturedLog = { level: number; msg: string } & Record<string, unknown>;

export function capturedLogger() {
  const logs: CapturedLog[] = [];
  const logger = pino(
    { level: "info", base: null, timestamp: false },
    { write: (line: string) => logs.push(JSON.parse(line) as CapturedLog) },
  );
  return { logger, logs };
}

const ESCAPED_SECONDS = 60;
const GONE_POLLS = 40;
const GONE_POLL_MS = 50;
const PROCESS_ABSENT = "ESRCH";
export const PROCESS_TREE_PIDS = 4;

export function processTreeCommand(): string {
  const escape = `const c=require("node:child_process").spawn("sleep",["${ESCAPED_SECONDS}"],{detached:true,stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)`;
  return [
    `sh -c 'sleep ${ESCAPED_SECONDS} & echo $!; sleep ${ESCAPED_SECONDS}' &`,
    `echo $!`,
    `"${process.execPath}" -e '${escape}' &`,
    `echo $!`,
    `wait`,
  ].join("\n");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, PROCESS_ABSENT);
    return false;
  }
}

type TextContent = readonly { type: string; text?: string }[];

export function pidsIn(content: TextContent): number[] {
  const text = content.map((part) => part.text ?? "").join("");
  return (text.match(/^\d+$/gm) ?? []).map(Number);
}

export function spawnedPids(t: TestContext, content: TextContent): number[] {
  const spawned = pidsIn(content);
  t.after(() => {
    for (const pid of spawned.filter(alive)) process.kill(pid, "SIGKILL");
  });
  return spawned;
}

export async function survivingProcesses(
  pids: readonly number[],
): Promise<number[]> {
  for (let poll = 0; poll < GONE_POLLS; poll += 1) {
    if (!pids.some(alive)) return [];
    await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
  }
  return pids.filter(alive);
}

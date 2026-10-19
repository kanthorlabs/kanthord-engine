import assert from "node:assert/strict";
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
    "CREATE TABLE IF NOT EXISTS memory_credential_hold (credential TEXT PRIMARY KEY, available_at INTEGER NOT NULL, strikes INTEGER NOT NULL)",
  );
  return tx.database;
}

export function memoryCredentialHolds(): CredentialHolds {
  return {
    holdOf: (tx, name) => {
      const row = holdTable(tx)
        .prepare(
          "SELECT available_at, strikes FROM memory_credential_hold WHERE credential = ?",
        )
        .get(name) as CredentialHold | undefined;
      return row === undefined ? null : { ...row };
    },
    hold: (tx, name, availableAt, strikes) => {
      holdTable(tx)
        .prepare(
          "INSERT OR REPLACE INTO memory_credential_hold (credential, available_at, strikes) VALUES (?, ?, ?)",
        )
        .run(name, availableAt, strikes);
    },
    release: (tx, name) =>
      holdTable(tx)
        .prepare(
          "DELETE FROM memory_credential_hold WHERE credential = ? AND strikes > ?",
        )
        .run(name, NO_STRIKES).changes > NO_ROWS,
    listHolds: (tx) =>
      holdTable(tx)
        .prepare(
          "SELECT credential, available_at, strikes FROM memory_credential_hold WHERE strikes > ? ORDER BY credential",
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

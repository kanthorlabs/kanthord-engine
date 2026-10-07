import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import type {
  AgentProviderDependent,
  AgentProviderItem,
  AgentProviderKind as AgentProviderKindValue,
  DefaultConfiguration,
} from "./contract.ts";

export const EnablementState = {
  Enabled: "enabled",
  Disabled: "disabled",
} as const;
export type EnablementState =
  (typeof EnablementState)[keyof typeof EnablementState];

export const AgentProviderKind = {
  GithubCopilot: "github-copilot",
  OpenaiCodex: "openai-codex",
  Anthropic: "anthropic",
  OpenaiCompatible: "openai-compatible",
  Openrouter: "openrouter",
} as const satisfies Record<string, AgentProviderKindValue>;

export type EnablementRow = {
  id: string;
  agentName: string;
  revision: number;
  state: EnablementState;
  agentProviders: AgentProviderItem[];
  defaultConfiguration: DefaultConfiguration;
  createdAt: number;
  removedAt: number | null;
};

type DatabaseRow = {
  id: string;
  agent_name: string;
  revision: number;
  state: EnablementState;
  agent_providers: string;
  default_configuration: string;
  created_at: number;
  removed_at: number | null;
};

const AGENT_ENABLEMENT_PREFIX = "agent_enablement";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const INITIAL_REVISION = 0;
const EXTRA_ROW = 1;
const FIRST_ROW = 0;
const ALL_ROWS_LIMIT = -1;

function toEnablement(row: DatabaseRow): EnablementRow {
  return {
    id: row.id,
    agentName: row.agent_name,
    revision: row.revision,
    state: row.state,
    agentProviders: JSON.parse(row.agent_providers) as AgentProviderItem[],
    defaultConfiguration: JSON.parse(
      row.default_configuration,
    ) as DefaultConfiguration,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  };
}

function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (
    !CURSOR_PATTERN.test(cursor) ||
    Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      CURSOR_INVALID_CODE,
      "Invalid cursor.",
    );
  return decoded;
}

function liveEnablements(
  tx: Transaction,
  after: string | null = null,
  limit: number = ALL_ROWS_LIMIT,
): EnablementRow[] {
  const rows = tx.database
    .prepare(
      `SELECT e.id, e.agent_name, e.revision, e.state, e.agent_providers, e.default_configuration, e.created_at, e.removed_at
       FROM agent_enablement AS e
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_enablement AS newer
         WHERE newer.agent_name = e.agent_name AND newer.revision > e.revision
       ) AND e.removed_at IS NULL AND (? IS NULL OR e.agent_name > ?)
       ORDER BY e.agent_name ASC LIMIT ?`,
    )
    .all(after, after, limit) as DatabaseRow[];
  return rows.map(toEnablement);
}

export function listEnablements(
  tx: Transaction,
  limit: number,
  cursor: string | null,
): { items: EnablementRow[]; next_cursor: string | null } {
  const after = cursor === null ? null : decodeCursor(cursor);
  const rows = liveEnablements(tx, after, limit + EXTRA_ROW);
  const items = rows.slice(FIRST_ROW, limit);
  const nextCursor =
    rows.length > limit
      ? Buffer.from(items.at(-1)!.agentName, TEXT_ENCODING).toString(
          CURSOR_ENCODING,
        )
      : null;
  return { items, next_cursor: nextCursor };
}

export function getEnablement(
  tx: Transaction,
  agentName: string,
): EnablementRow | null {
  const row = tx.database
    .prepare(
      `SELECT id, agent_name, revision, state, agent_providers, default_configuration, created_at, removed_at
       FROM agent_enablement WHERE agent_name = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(agentName) as DatabaseRow | undefined;
  return row && row.removed_at === null ? toEnablement(row) : null;
}

export function getLatestRevision(
  tx: Transaction,
  agentName: string,
): { revision: number } | null {
  const row = tx.database
    .prepare(
      "SELECT revision FROM agent_enablement WHERE agent_name = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(agentName) as { revision: number } | undefined;
  return row ? { revision: row.revision } : null;
}

export function insertEnablementRevision(
  tx: Transaction,
  agentName: string,
  state: EnablementState,
  agentProviders: AgentProviderItem[],
  defaultConfiguration: DefaultConfiguration,
  removedAt?: number,
): EnablementRow {
  const id = createIdentity(AGENT_ENABLEMENT_PREFIX);
  const { revision } = tx.database
    .prepare(
      "SELECT COALESCE(MAX(revision), ?) + 1 AS revision FROM agent_enablement WHERE agent_name = ?",
    )
    .get(INITIAL_REVISION, agentName) as { revision: number };
  const createdAt = Date.now();
  const row: EnablementRow = {
    id,
    agentName,
    revision,
    state,
    agentProviders,
    defaultConfiguration,
    createdAt,
    removedAt: removedAt ?? null,
  };
  tx.database
    .prepare(
      `INSERT INTO agent_enablement
       (id, agent_name, revision, state, agent_providers, default_configuration, created_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      agentName,
      revision,
      state,
      canonicalJSON(agentProviders),
      canonicalJSON(defaultConfiguration),
      createdAt,
      row.removedAt,
    );
  return row;
}

export function agentProvidersDependentOn(
  tx: Transaction,
  credentialName: string,
): AgentProviderDependent[] {
  return liveEnablements(tx).flatMap((row) =>
    row.agentProviders
      .filter((item) => item.credential === credentialName)
      .map((item) => ({ agentName: row.agentName, providerName: item.name })),
  );
}

export function enablementsByModel(
  tx: Transaction,
  credentialName: string,
  modelId: string,
): EnablementRow[] {
  return liveEnablements(tx).filter(
    (row) =>
      row.defaultConfiguration.modelIdentifier === modelId &&
      row.agentProviders.some(
        (item) =>
          item.name === row.defaultConfiguration.agentProvider &&
          item.credential === credentialName,
      ),
  );
}

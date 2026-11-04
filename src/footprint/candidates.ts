import { createHash } from "node:crypto";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { NodeState, type NodeStateFact } from "../mission/contract.ts";
import type { FootprintItem } from "../worker/contract.ts";
import {
  CleanableKind,
  CleanupRefusal,
  CleanupRule,
  type CleanupRuleValue,
  DEFAULT_AGE_DAYS,
  type FootprintCandidate,
  FootprintErrorCode,
  KIND_RULES,
  olderThanCutoff,
} from "./contract.ts";

const BASE64URL = "base64url";
const UTF8 = "utf8";
const CURSOR_SEPARATOR = ".";
const FINGERPRINT_LENGTH = 16;
const NOT_FOUND = -1;
const DECIMAL = /^(0|[1-9]\d*)$/;

export function ruleValue(
  name: CleanupRule,
  olderThanDays: number | undefined,
): CleanupRuleValue {
  return name === CleanupRule.OlderThan
    ? { name, older_than_days: olderThanDays ?? DEFAULT_AGE_DAYS }
    : { name };
}

export function defaultRule(kind: CleanableKind): CleanupRuleValue {
  return ruleValue(KIND_RULES[kind][0]!, DEFAULT_AGE_DAYS);
}

export function ruleSupported(
  kind: CleanableKind,
  rule: CleanupRuleValue,
): boolean {
  return KIND_RULES[kind].includes(rule.name);
}

function fingerprint(scope: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(scope))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

function cursorInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    FootprintErrorCode.CursorInvalid,
    "Invalid cursor.",
  );
}

export function encodeCursor(scope: unknown, position: string): string {
  return Buffer.from(
    `${fingerprint(scope)}${CURSOR_SEPARATOR}${position}`,
    UTF8,
  ).toString(BASE64URL);
}

export function decodeCursor(
  scope: unknown,
  cursor: string | undefined,
): string | null {
  if (cursor === undefined) return null;
  const text = Buffer.from(cursor, BASE64URL).toString(UTF8);
  const separator = text.indexOf(CURSOR_SEPARATOR);
  if (
    Buffer.from(text, UTF8).toString(BASE64URL) !== cursor ||
    separator === NOT_FOUND ||
    text.slice(0, separator) !== fingerprint(scope)
  )
    throw cursorInvalid();
  return text.slice(separator + 1);
}

export function offsetOf(position: string | null): number {
  if (position === null) return 0;
  if (!DECIMAL.test(position)) throw cursorInvalid();
  const offset = Number(position);
  if (!Number.isSafeInteger(offset)) throw cursorInvalid();
  return offset;
}

export interface InstanceFacts {
  readonly endTimes: ReadonlyMap<string, number | null>;
  readonly nodeStates: ReadonlyMap<string, NodeStateFact>;
}

const NODE_PREFIX = "node_";
const EXECUTION_PREFIX = "execution_";
const CLOSED_STATES: readonly string[] = [
  NodeState.Completed,
  NodeState.Discarded,
];

export function factKeys(
  kind: CleanableKind,
  items: readonly FootprintItem[],
): { executions: string[]; nodes: string[] } {
  if (kind === CleanableKind.Session)
    return { executions: items.map((item) => item.key), nodes: [] };
  if (kind !== CleanableKind.Workspace) return { executions: [], nodes: [] };
  return {
    executions: items
      .map((item) => item.key)
      .filter((key) => key.startsWith(EXECUTION_PREFIX)),
    nodes: items
      .map((item) => item.key)
      .filter((key) => key.startsWith(NODE_PREFIX)),
  };
}

interface Judged {
  readonly candidate: FootprintCandidate;
  readonly selectable: boolean;
}

function judged(
  kind: CleanableKind,
  item: FootprintItem,
  facts: InstanceFacts,
): Judged {
  const base = {
    key: item.key,
    at: item.modified_at,
    bytes: item.bytes,
    project_id: null,
    node_id: null,
    execution_id: null,
    refusal: null,
    kept: false,
  };
  if (kind === CleanableKind.Session) {
    const ended = facts.endTimes.get(item.key);
    const live = ended === null;
    return {
      candidate: {
        ...base,
        at: ended ?? item.modified_at,
        execution_id: item.key,
        refusal: live ? CleanupRefusal.Live : null,
      },
      selectable: !live,
    };
  }
  if (kind === CleanableKind.Workspace && item.key.startsWith(NODE_PREFIX)) {
    const node = facts.nodeStates.get(item.key);
    return {
      candidate: { ...base, node_id: item.key },
      selectable:
        node === undefined ||
        node.retired ||
        CLOSED_STATES.includes(node.state),
    };
  }
  if (kind === CleanableKind.Workspace) {
    const live = facts.endTimes.get(item.key) === null;
    return {
      candidate: {
        ...base,
        execution_id: item.key,
        refusal: live ? CleanupRefusal.Live : null,
      },
      selectable: !live,
    };
  }
  return { candidate: base, selectable: true };
}

export function instanceCandidates(
  kind: CleanableKind,
  items: readonly FootprintItem[],
  rule: CleanupRuleValue | null,
  facts: InstanceFacts,
  now: number,
): FootprintCandidate[] {
  const cutoff = olderThanCutoff(rule, now);
  return items
    .map((item) => judged(kind, item, facts))
    .filter(
      (entry) =>
        rule === null ||
        (entry.selectable && (cutoff === null || entry.candidate.at < cutoff)),
    )
    .map((entry) => entry.candidate)
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

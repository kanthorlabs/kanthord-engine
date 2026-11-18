import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Operation } from "../kernel/operation.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  WORKBENCH_PROJECT_SCOPE_TEXT,
  WORKBENCH_REQUEST_OWNER_ACT_TOOL,
  WORKBENCH_SCOPE_REQUEST_PREFIX,
} from "./contract.ts";
import { grantableOperations, grantCovers } from "./guard.ts";

export const WORKBENCH_SCOPE_REQUEST_LIMIT = 10;
export const WORKBENCH_SCOPE_REQUEST_REPEAT_MS = 86_400_000;

const EXPECTED_PREFIX = "expected_";
const BLOCKED_ATTEMPT_KEY = "blocked_attempt";
const TARGET_KEYS = ["node_id", "project_id"] as const;
const BODY_PART = "body";
const ONE_PROJECT = 1;

export const ScopeRequestState = {
  Open: "open",
  Running: "running",
} as const;
type ScopeRequestState =
  (typeof ScopeRequestState)[keyof typeof ScopeRequestState];

export function isConcurrencyKey(key: string): boolean {
  return key.startsWith(EXPECTED_PREFIX) || key === BLOCKED_ATTEMPT_KEY;
}

export interface ScopeRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly inviteId: string;
  readonly guestName: string;
  readonly agentName: string;
  readonly operationId: string;
  readonly input: unknown;
  readonly targetId: string;
  readonly ids: readonly string[];
  readonly projectId: string;
  readonly expectedKeys: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  state: ScopeRequestState;
  error: string | null;
}

export interface RaiseInput {
  readonly sessionId: string;
  readonly inviteId: string;
  readonly inviteExpiresAt: number;
  readonly guestName: string;
  readonly agentName: string;
  readonly operation: Operation;
  readonly input: unknown;
  readonly projects: ReadonlyMap<string, string | null>;
  readonly scope: ReadonlySet<string>;
}

function withoutConcurrencyKeys(part: unknown): unknown {
  if (!isObject(part) || Array.isArray(part)) return part;
  return Object.fromEntries(
    Object.entries(part).filter(([key]) => !isConcurrencyKey(key)),
  );
}

function repeatKey(
  inviteId: string,
  operationId: string,
  input: unknown,
): string {
  const parts = isObject(input) ? (input as Record<string, unknown>) : {};
  return canonicalJSON([
    inviteId,
    operationId,
    withoutConcurrencyKeys(parts.params),
    withoutConcurrencyKeys(parts.query),
    withoutConcurrencyKeys(parts[BODY_PART]),
  ]);
}

function targetOf(input: unknown): string | null {
  const params = isObject(input)
    ? (input as Record<string, unknown>).params
    : undefined;
  if (!isObject(params)) return null;
  for (const key of TARGET_KEYS) {
    const value = (params as Record<string, unknown>)[key];
    if (isString(value)) return value;
  }
  return null;
}

function expectedKeysOf(operation: Operation): string[] {
  const input = operation.input as unknown as z.ZodObject;
  const body = input.shape[BODY_PART];
  if (!(body instanceof z.ZodObject)) return [];
  return Object.keys(body.shape).filter(isConcurrencyKey).sort();
}

function eligible(agentName: string, operation: Operation, input: unknown) {
  const grantable = new Set(grantableOperations(agentName).keys());
  return grantCovers(grantable, { operationId: operation.id, input });
}

function outsideProject(
  projects: ReadonlyMap<string, string | null>,
  scope: ReadonlySet<string>,
): string | null {
  const owners = new Set(projects.values());
  if (owners.size !== ONE_PROJECT) return null;
  const [owner] = owners;
  return owner === null || owner === undefined || scope.has(owner)
    ? null
    : owner;
}

export class ScopeRequests {
  private readonly clock: () => number;
  private readonly requests = new Map<string, ScopeRequest>();
  private readonly settled = new Map<string, number>();

  constructor(clock: () => number) {
    this.clock = clock;
  }

  private prune(): void {
    const now = this.clock();
    for (const [id, request] of this.requests)
      if (request.expiresAt <= now) this.requests.delete(id);
    for (const [key, at] of this.settled)
      if (now - at >= WORKBENCH_SCOPE_REQUEST_REPEAT_MS)
        this.settled.delete(key);
  }

  private ofInvite(inviteId: string): ScopeRequest[] {
    return [...this.requests.values()].filter(
      (request) => request.inviteId === inviteId,
    );
  }

  private repeats(inviteId: string, key: string): boolean {
    if (this.settled.has(key)) return true;
    return this.ofInvite(inviteId).some(
      (request) =>
        repeatKey(request.inviteId, request.operationId, request.input) === key,
    );
  }

  private remember(request: ScopeRequest): void {
    this.settled.set(
      repeatKey(request.inviteId, request.operationId, request.input),
      this.clock(),
    );
  }

  raise(input: RaiseInput): ScopeRequest | null {
    this.prune();
    const projectId = outsideProject(input.projects, input.scope);
    if (projectId === null) return null;
    if (!eligible(input.agentName, input.operation, input.input)) return null;
    const targetId = targetOf(input.input);
    if (targetId === null) return null;
    if (this.ofInvite(input.inviteId).length >= WORKBENCH_SCOPE_REQUEST_LIMIT)
      return null;
    const key = repeatKey(input.inviteId, input.operation.id, input.input);
    if (this.repeats(input.inviteId, key)) return null;
    const request: ScopeRequest = {
      id: createIdentity(WORKBENCH_SCOPE_REQUEST_PREFIX),
      sessionId: input.sessionId,
      inviteId: input.inviteId,
      guestName: input.guestName,
      agentName: input.agentName,
      operationId: input.operation.id,
      input: input.input,
      targetId,
      ids: [...input.projects.keys()].sort(),
      projectId,
      expectedKeys: expectedKeysOf(input.operation),
      createdAt: this.clock(),
      expiresAt: input.inviteExpiresAt,
      state: ScopeRequestState.Open,
      error: null,
    };
    this.requests.set(request.id, request);
    return request;
  }

  open(sessionId: string): readonly ScopeRequest[] {
    this.prune();
    return [...this.requests.values()].filter(
      (request) =>
        request.sessionId === sessionId &&
        request.state === ScopeRequestState.Open,
    );
  }

  count(sessionId: string): number {
    return this.open(sessionId).length;
  }

  claim(sessionId: string, requestId: string): ScopeRequest | null {
    this.prune();
    const request = this.requests.get(requestId);
    if (
      !request ||
      request.sessionId !== sessionId ||
      request.state !== ScopeRequestState.Open
    )
      return null;
    request.state = ScopeRequestState.Running;
    return request;
  }

  release(request: ScopeRequest, error: string): void {
    if (this.requests.get(request.id) !== request) return;
    if (request.state !== ScopeRequestState.Running) return;
    request.state = ScopeRequestState.Open;
    request.error = error;
  }

  settle(request: ScopeRequest): void {
    this.requests.delete(request.id);
    this.remember(request);
  }

  reject(sessionId: string, requestId: string): ScopeRequest | null {
    this.prune();
    const request = this.requests.get(requestId);
    if (
      !request ||
      request.sessionId !== sessionId ||
      request.state !== ScopeRequestState.Open
    )
      return null;
    this.requests.delete(request.id);
    this.remember(request);
    return request;
  }

  dropInvite(inviteId: string): void {
    for (const request of this.ofInvite(inviteId))
      this.requests.delete(request.id);
  }
}

export const requestOwnerActParams = z.strictObject({
  operation_id: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const REQUEST_OWNER_ACT_PARAMETERS = Type.Object(
  {
    operation_id: Type.String(),
    input: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

const REQUEST_OWNER_ACT_DESCRIPTION =
  "Ask the owner to run one act on a record that is not available in this conversation. The act never runs in this run. The run ends.";

export interface OwnerActCall {
  readonly operationId: string;
  readonly input: Record<string, unknown> | null;
}

function holdsConcurrencyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsConcurrencyKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => isConcurrencyKey(key) || holdsConcurrencyKey(item),
  );
}

function ownerActCall(params: unknown): OwnerActCall {
  const parsed = requestOwnerActParams.safeParse(params);
  if (!parsed.success) return { operationId: "", input: null };
  const { operation_id: operationId, input } = parsed.data;
  return {
    operationId,
    input: holdsConcurrencyKey(input[BODY_PART]) ? null : input,
  };
}

export function requestInputSchema(operation: Operation): z.ZodType {
  const input = operation.input as unknown as z.ZodObject;
  const body = input.shape[BODY_PART];
  if (!(body instanceof z.ZodObject)) return input;
  const omitted = Object.fromEntries(
    Object.keys(body.shape)
      .filter(isConcurrencyKey)
      .map((key) => [key, true as const]),
  );
  return z.strictObject({
    ...input.shape,
    [BODY_PART]: body.omit(omitted as never),
  });
}

export function requestOwnerActTool(
  onCall: (toolCallId: string, call: OwnerActCall) => void,
): ToolDefinition {
  return {
    name: WORKBENCH_REQUEST_OWNER_ACT_TOOL,
    label: WORKBENCH_REQUEST_OWNER_ACT_TOOL,
    description: REQUEST_OWNER_ACT_DESCRIPTION,
    parameters: REQUEST_OWNER_ACT_PARAMETERS,
    execute(toolCallId, params) {
      onCall(toolCallId, ownerActCall(params));
      return Promise.resolve({
        content: [{ type: "text", text: WORKBENCH_PROJECT_SCOPE_TEXT }],
        details: {},
        terminate: true,
      });
    },
  };
}

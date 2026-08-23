import type { IdentityKind } from "../../domain/identity.ts";

export const resourceSegments = [
  "actor",
  "agent",
  "attempt",
  "blob",
  "event",
  "git-operation",
  "instruction",
  "node",
  "project",
  "provider",
  "repository",
  "run",
  "template",
  "worker",
] as const;

export const subresourceSegments = [
  "approval",
  "attempt",
  "binding",
  "check",
  "default",
  "edge",
  "graph",
  "llm",
  "node",
  "plan",
  "profile",
  "repository",
  "revision",
  "run",
  "status",
  "worker",
] as const;

export const actionSegments = [
  "abandon",
  "approve",
  "cancel",
  "claim",
  "delete",
  "discard",
  "export",
  "heartbeat",
  "import",
  "inspect",
  "publish",
  "reconcile",
  "release",
  "rename",
  "report",
  "resolve",
  "revoke",
  "rotate",
  "unblock",
  "update",
  "validate",
  "verify",
  "waive",
] as const;

export const systemNamespaceSegments = ["db"] as const;
export const systemLeafSegments = ["health", "status"] as const;
export const systemSegments = ["db", "health", "status"] as const;

export type ResourceSegment = (typeof resourceSegments)[number];
export type SubresourceSegment = (typeof subresourceSegments)[number];
export type ActionSegment = (typeof actionSegments)[number];
export type SystemSegment = (typeof systemSegments)[number];

export type ParameterIdentity = IdentityKind | "node" | "deferred";

export type Segment =
  | Readonly<{ kind: "resource"; value: ResourceSegment }>
  | Readonly<{ kind: "subresource"; value: SubresourceSegment }>
  | Readonly<{ kind: "action"; value: ActionSegment }>
  | Readonly<{ kind: "system"; value: SystemSegment }>
  | Readonly<{ kind: "parameter"; value: "id"; identity: ParameterIdentity }>
  | Readonly<{ kind: "parameter"; value: "hash" }>;

export function resource(value: ResourceSegment): Segment {
  return { kind: "resource", value };
}

export function sub(value: SubresourceSegment): Segment {
  return { kind: "subresource", value };
}

export function action(value: ActionSegment): Segment {
  return { kind: "action", value };
}

export function system(value: SystemSegment): Segment {
  return { kind: "system", value };
}

export function parameter(identity: ParameterIdentity): Segment {
  return { kind: "parameter", value: "id", identity };
}

export function hash(): Segment {
  return { kind: "parameter", value: "hash" };
}

export function renderPath(segments: readonly Segment[]): string {
  const rendered = segments.map((segment) => {
    if (segment.kind === "parameter") {
      return `:${segment.value}`;
    }
    return segment.value;
  });
  return `/v1${rendered.length === 0 ? "" : `/${rendered.join("/")}`}`;
}

export function renderOpenApiPath(segments: readonly Segment[]): string {
  const rendered = segments.map((segment) => {
    if (segment.kind === "parameter") {
      return `{${segment.value}}`;
    }
    return segment.value;
  });
  return `/v1${rendered.length === 0 ? "" : `/${rendered.join("/")}`}`;
}

export function parameterNames(
  segments: readonly Segment[],
): readonly string[] {
  return segments
    .filter((segment) => segment.kind === "parameter")
    .map((segment) => segment.value);
}

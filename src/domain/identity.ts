import { z } from "zod";

export const identityKinds = [
  "provider",
  "providerLogin",
  "project",
  "repository",
  "profile",
  "initiative",
  "objective",
  "task",
  "edge",
  "planRevision",
  "workspace",
  "run",
  "attempt",
  "agentInvocation",
  "candidate",
  "checkResult",
  "gitOperation",
  "event",
  "actor",
] as const;

export type IdentityKind = (typeof identityKinds)[number];

export const identityPrefixes: Readonly<Record<IdentityKind, string>> = {
  provider: "provider",
  providerLogin: "login",
  project: "project",
  repository: "repo",
  profile: "profile",
  initiative: "initiative",
  objective: "objective",
  task: "task",
  edge: "edge",
  planRevision: "revision",
  workspace: "workspace",
  run: "run",
  attempt: "attempt",
  agentInvocation: "invocation",
  candidate: "candidate",
  checkResult: "check",
  gitOperation: "gitop",
  event: "event",
  actor: "actor",
};

export const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export type Identity = Readonly<{
  kind: IdentityKind;
  prefix: string;
  ulid: string;
}>;

export type IdentityErrorCode = "identity-kind-mismatch";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

const prefixToKind: Readonly<Record<string, IdentityKind>> = (() => {
  const map: Record<string, IdentityKind> = {};
  for (const kind of identityKinds) {
    map[identityPrefixes[kind]] = kind;
  }
  return map;
})();

export function parseIdentity(value: string): Identity | null {
  const underscoreIndex = value.indexOf("_");
  if (underscoreIndex === -1) return null;

  const prefix = value.slice(0, underscoreIndex);
  const kind = prefixToKind[prefix];
  if (kind === undefined) return null;

  const ulid = value.slice(underscoreIndex + 1);
  if (!ulidPattern.test(ulid)) return null;

  return { kind, prefix, ulid };
}

export function assertIdentity(value: string, kind: IdentityKind): Identity {
  const result = parseIdentity(value);
  if (result === null || result.kind !== kind) {
    throw new IdentityError(
      "identity-kind-mismatch",
      `${value} is not a ${kind} identity`,
    );
  }
  return result;
}

const identitySchemaCache = new Map<IdentityKind, z.ZodType<string>>();

export function identity(kind: IdentityKind): z.ZodType<string> {
  let schema = identitySchemaCache.get(kind);
  if (schema === undefined) {
    schema = z.string().refine((value) => parseIdentity(value)?.kind === kind, {
      message: `expected a ${identityPrefixes[kind]}_ identity`,
    });
    identitySchemaCache.set(kind, schema);
  }
  return schema;
}

export const anyIdentity: z.ZodType<string> = z
  .string()
  .refine((value) => parseIdentity(value) !== null, {
    message: "expected a prefixed ULID identity",
  });

const nodeKinds: ReadonlySet<IdentityKind> = new Set<IdentityKind>([
  "initiative",
  "objective",
  "task",
]);

export const nodeIdentity: z.ZodType<string> = z.string().refine(
  (value) => {
    const parsed = parseIdentity(value);
    return parsed !== null && nodeKinds.has(parsed.kind);
  },
  { message: "expected an initiative_, objective_ or task_ identity" },
);

const ulidTimeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function identityTime(value: string): number | null {
  const identity = parseIdentity(value);
  if (identity === null) {
    return null;
  }
  return identity.ulid
    .slice(0, 10)
    .split("")
    .reduce(
      (total, character) => total * 32 + ulidTimeAlphabet.indexOf(character),
      0,
    );
}

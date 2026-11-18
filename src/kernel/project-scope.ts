import type { Operation } from "./operation.ts";

export const ProjectScopeRule = {
  Target: "target",
  TargetJson: "target_json",
  List: "list",
} as const;
export type ProjectScopeRule =
  (typeof ProjectScopeRule)[keyof typeof ProjectScopeRule];

export const PROJECT_BOUND_PREFIXES = [
  "project",
  "binding",
  "mission",
  "node",
  "proposal",
  "assessment",
  "evidence",
  "evidence_asset",
] as const;
export type ProjectBoundPrefix = (typeof PROJECT_BOUND_PREFIXES)[number];

export const SCOPE_IDENTITY_LIMIT = 256;

export const ScopeVerdict = {
  Allowed: "allowed",
  NotFound: "not_found",
  Refused: "refused",
} as const;
export type ScopeVerdict = (typeof ScopeVerdict)[keyof typeof ScopeVerdict];

export interface ProjectLookup {
  projectOf(prefix: ProjectBoundPrefix, id: string): string | null;
}

export interface ScopedInput {
  params: unknown;
  query: unknown;
  body: unknown;
}

export interface ScopeCheck {
  readonly input: ScopedInput;
  readonly scope: ReadonlySet<string>;
}

const IDENTITY_PATTERN =
  /\b(project|binding|mission|node|proposal|assessment|evidence_asset|evidence)_[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
const PREFIX_SEPARATOR = "_";
const STRING_TYPE = "string";
const OBJECT_TYPE = "object";
const EMPTY_SIZE = 0;
const PROJECT_ID_KEY = "project_id";
const JSON_FORMAT = "json";

function isString(value: unknown): value is string {
  return typeof value === STRING_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === OBJECT_TYPE && value !== null && !Array.isArray(value)
  );
}

function stringLeaves(value: unknown, into: string[]): void {
  if (isString(value)) {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) stringLeaves(item, into);
  }
}

function collectIdentities(input: ScopedInput): Set<string> {
  const leaves: string[] = [];
  stringLeaves(input.params, leaves);
  stringLeaves(input.query, leaves);
  stringLeaves(input.body, leaves);
  const found = new Set<string>();
  for (const leaf of leaves) {
    for (const match of leaf.matchAll(IDENTITY_PATTERN)) found.add(match[0]);
  }
  return found;
}

function prefixOf(identity: string): ProjectBoundPrefix {
  const prefix = identity.slice(0, identity.lastIndexOf(PREFIX_SEPARATOR));
  return prefix as ProjectBoundPrefix;
}

function requestedIds(query: unknown): string[] {
  if (!isRecord(query)) return [];
  const id = query["id"];
  if (isString(id)) return [id];
  if (Array.isArray(id)) {
    return id.filter(isString);
  }
  return [];
}

function answerHoldsForeignProject(
  value: unknown,
  scope: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => answerHoldsForeignProject(item, scope));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    key === PROJECT_ID_KEY && isString(item)
      ? !scope.has(item)
      : answerHoldsForeignProject(item, scope),
  );
}

function listItemsInScope(
  answer: unknown,
  scope: ReadonlySet<string>,
): boolean {
  if (!isRecord(answer) || !Array.isArray(answer["items"])) return true;
  return answer["items"].every(
    (item) => !isRecord(item) || scope.has(String(item["id"])),
  );
}

export interface ScopeResolution {
  readonly verdict: ScopeVerdict;
  readonly projects: ReadonlyMap<string, string | null>;
}

const NO_PROJECTS: ReadonlyMap<string, string | null> = new Map();

function resolution(
  verdict: ScopeVerdict,
  projects: ReadonlyMap<string, string | null> = NO_PROJECTS,
): ScopeResolution {
  return { verdict, projects };
}

export class ProjectScope {
  readonly #lookup: ProjectLookup;

  constructor(lookup: ProjectLookup) {
    this.#lookup = lookup;
  }

  check(operation: Operation, request: ScopeCheck): ScopeVerdict {
    return this.resolve(operation, request).verdict;
  }

  resolve(operation: Operation, request: ScopeCheck): ScopeResolution {
    const rule = operation.projectScope;
    if (rule === undefined) return resolution(ScopeVerdict.Refused);
    if (rule === ProjectScopeRule.List) return resolution(ScopeVerdict.Allowed);
    if (rule === ProjectScopeRule.TargetJson && !this.#isJson(request.input)) {
      return resolution(ScopeVerdict.Refused);
    }
    const identities = collectIdentities(request.input);
    if (identities.size > SCOPE_IDENTITY_LIMIT) {
      return resolution(ScopeVerdict.Refused);
    }
    if (identities.size === EMPTY_SIZE) return resolution(ScopeVerdict.Refused);
    return this.#resolveIdentities(identities, request.scope);
  }

  narrow(input: ScopedInput, scope: ReadonlySet<string>): ScopedInput | null {
    const requested = requestedIds(input.query);
    const ids =
      requested.length === EMPTY_SIZE
        ? [...scope]
        : requested.filter((id) => scope.has(id));
    if (ids.length === EMPTY_SIZE) return null;
    const query = isRecord(input.query) ? input.query : {};
    return { ...input, query: { ...query, id: ids } };
  }

  admitsAnswer(
    operation: Operation,
    answer: unknown,
    request: ScopeCheck,
  ): boolean {
    if (answer instanceof Response) return true;
    if (answerHoldsForeignProject(answer, request.scope)) return false;
    if (operation.projectScope !== ProjectScopeRule.List) return true;
    return listItemsInScope(answer, request.scope);
  }

  #isJson(input: ScopedInput): boolean {
    return isRecord(input.body) && input.body["format"] === JSON_FORMAT;
  }

  #resolveIdentities(
    identities: ReadonlySet<string>,
    scope: ReadonlySet<string>,
  ): ScopeResolution {
    let verdict: ScopeVerdict = ScopeVerdict.Allowed;
    const projects = new Map<string, string | null>();
    for (const identity of identities) {
      const project = this.#lookup.projectOf(prefixOf(identity), identity);
      projects.set(identity, project);
      if (project === null || !scope.has(project)) {
        verdict = ScopeVerdict.NotFound;
      }
    }
    return resolution(verdict, projects);
  }
}

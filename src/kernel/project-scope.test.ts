import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createIdentity } from "./identity.ts";
import { AccessPolicy, OperationLifetime, StoreName } from "./operation.ts";
import type { Operation } from "./operation.ts";
import { HttpMethod } from "./http.ts";
import {
  PROJECT_BOUND_PREFIXES,
  ProjectScope,
  ProjectScopeRule,
  SCOPE_IDENTITY_LIMIT,
  ScopeVerdict,
} from "./project-scope.ts";
import type {
  ProjectBoundPrefix,
  ProjectLookup,
  ScopedInput,
} from "./project-scope.ts";

const TWO_IDENTITIES = 2;
const inProject = createIdentity("project");
const otherProject = createIdentity("project");
const scope: ReadonlySet<string> = new Set([inProject]);

class CountingLookup implements ProjectLookup {
  readonly owners = new Map<string, string>();
  calls = 0;
  projectOf(_prefix: ProjectBoundPrefix, id: string): string | null {
    this.calls += 1;
    return this.owners.get(id) ?? null;
  }
}

function declaration(projectScope?: ProjectScopeRule): Operation {
  return {
    id: "scope.probe",
    service: "scope",
    method: HttpMethod.Post,
    path: "/api/scope/probe",
    access: AccessPolicy.Human,
    timeoutMs: 0,
    mutation: false,
    store: StoreName.Operational,
    input: z.unknown(),
    output: z.unknown(),
    status: 200,
    lifetime: OperationLifetime.Unary,
    description: "Probe.",
    ...(projectScope === undefined ? {} : { projectScope }),
  };
}

function input(body: unknown, params: unknown = {}): ScopedInput {
  return { params, query: {}, body };
}

test("security: an unknown id and a foreign id give the same verdict for each prefix", () => {
  const target = declaration(ProjectScopeRule.Target);
  for (const prefix of PROJECT_BOUND_PREFIXES) {
    const lookup = new CountingLookup();
    const foreign = createIdentity(prefix);
    lookup.owners.set(foreign, otherProject);
    const resolver = new ProjectScope(lookup);
    const unknown = resolver.check(target, {
      input: input({ id: createIdentity(prefix) }),
      scope,
    });
    const other = resolver.check(target, {
      input: input({ id: foreign }),
      scope,
    });
    assert.equal(unknown, ScopeVerdict.NotFound);
    assert.equal(other, ScopeVerdict.NotFound);
  }
});

test("security: a foreign id inside a text field of the body gives not_found", () => {
  const lookup = new CountingLookup();
  const foreign = createIdentity("node");
  lookup.owners.set(foreign, otherProject);
  const verdict = new ProjectScope(lookup).check(
    declaration(ProjectScopeRule.Target),
    { input: input({ text: `please read ${foreign}.` }), scope },
  );
  assert.equal(verdict, ScopeVerdict.NotFound);
});

test("security: a declaration with no rule, no id or too many ids gives refused", () => {
  const resolver = new ProjectScope(new CountingLookup());
  const named = input({ id: inProject });
  assert.equal(
    resolver.check(declaration(), { input: named, scope }),
    ScopeVerdict.Refused,
  );
  assert.equal(
    resolver.check(declaration(ProjectScopeRule.Target), {
      input: input({ note: "none" }),
      scope,
    }),
    ScopeVerdict.Refused,
  );
  const many = Array.from({ length: SCOPE_IDENTITY_LIMIT + 1 }, () =>
    createIdentity("node"),
  );
  assert.equal(
    resolver.check(declaration(ProjectScopeRule.Target), {
      input: input({ ids: many }),
      scope,
    }),
    ScopeVerdict.Refused,
  );
});

test("security: target_json refuses markdown and checks the ids of a json body", () => {
  const lookup = new CountingLookup();
  const foreign = createIdentity("node");
  lookup.owners.set(foreign, otherProject);
  const resolver = new ProjectScope(lookup);
  const rule = declaration(ProjectScopeRule.TargetJson);
  assert.equal(
    resolver.check(rule, {
      input: input({ format: "markdown", entries: [{ id: foreign }] }),
      scope,
    }),
    ScopeVerdict.Refused,
  );
  assert.equal(
    resolver.check(rule, {
      input: input({ format: "json", entries: [{ id: foreign }] }),
      scope,
    }),
    ScopeVerdict.NotFound,
  );
});

test("security: the lookup count of a foreign id equals the count of an absent id", () => {
  const rule = declaration(ProjectScopeRule.Target);
  const mine = createIdentity("node");
  const foreign = createIdentity("node");
  const absent = createIdentity("node");

  const withForeign = new CountingLookup();
  withForeign.owners.set(mine, inProject);
  withForeign.owners.set(foreign, otherProject);
  new ProjectScope(withForeign).check(rule, {
    input: input({ ids: [foreign, mine] }),
    scope,
  });

  const withAbsent = new CountingLookup();
  withAbsent.owners.set(mine, inProject);
  new ProjectScope(withAbsent).check(rule, {
    input: input({ ids: [absent, mine] }),
    scope,
  });

  assert.equal(withForeign.calls, TWO_IDENTITIES);
  assert.equal(withAbsent.calls, withForeign.calls);
});

test("security: narrow drops a foreign id and answers null for only foreign ids", () => {
  const resolver = new ProjectScope(new CountingLookup());
  const narrowed = resolver.narrow(
    { params: {}, query: { id: [inProject, otherProject] }, body: null },
    scope,
  );
  assert.deepEqual(narrowed?.query, { id: [inProject] });
  assert.equal(
    resolver.narrow(
      { params: {}, query: { id: otherProject }, body: null },
      scope,
    ),
    null,
  );
});

test("security: admitsAnswer refuses a project_id and a list item outside the scope", () => {
  const resolver = new ProjectScope(new CountingLookup());
  const request = { input: input(null), scope };
  assert.equal(
    resolver.admitsAnswer(
      declaration(ProjectScopeRule.Target),
      { node: { owner: [{ project_id: otherProject }] } },
      request,
    ),
    false,
  );
  assert.equal(
    resolver.admitsAnswer(
      declaration(ProjectScopeRule.List),
      { items: [{ id: inProject }, { id: otherProject }], next_cursor: null },
      request,
    ),
    false,
  );
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";

import { registry } from "./registry.ts";
import { errorStatuses, buildErrorEnvelope } from "./errors.ts";
import { baselineErrors } from "./error-baseline.ts";
import { fieldDecisions } from "./field-decisions.fixture.ts";
import { cursorRequest } from "./cursor.ts";

const scoped = registry.filter(
  (entry) =>
    entry.status === "routed" &&
    entry.introducedIn === "phase-1" &&
    entry.operationId !== "blob.show",
);

const operationAdditions: Readonly<Record<string, readonly string[]>> = {
  "repository.inspect": ["credential-rejected", "host-key-mismatch"],
  "repository.register": ["credential-rejected", "host-key-mismatch"],
  "plan.import": [
    "plan-invalid",
    "choices-invalid",
    "choices-stale",
    "choices-changed",
    "stale-revision",
    "idempotency-mismatch",
  ],
  "plan.validate": ["plan-invalid"],
  "project.repositories": ["binding-in-use"],
  "node.create": [
    "stale-revision",
    "plan-invalid",
    "illegal-transition",
    "binding-in-use",
  ],
  "node.update": [
    "stale-revision",
    "plan-invalid",
    "illegal-transition",
    "binding-in-use",
  ],
  "node.delete": [
    "stale-revision",
    "plan-invalid",
    "illegal-transition",
    "binding-in-use",
  ],
  "node.claim": ["illegal-transition", "lease-held", "plan-invalid"],
  "node.heartbeat": ["illegal-transition", "lease-held", "plan-invalid"],
  "node.release": ["illegal-transition", "lease-held", "plan-invalid"],
  "node.report": [
    "acknowledgement-required",
    "illegal-transition",
    "lease-held",
  ],
  "node.unblock": ["illegal-transition"],
};

function objectNodes(schema: unknown): readonly Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];

  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "object") found.push(record);

    if (
      record.properties !== null &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
    ) {
      for (const value of Object.values(
        record.properties as Record<string, unknown>,
      )) {
        walk(value);
      }
    }
    if (record.items !== undefined) walk(record.items);
    if (
      record.additionalProperties !== undefined &&
      typeof record.additionalProperties === "object" &&
      record.additionalProperties !== null
    ) {
      walk(record.additionalProperties);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "not", "$defs"] as const) {
      if (record[key] !== undefined) walk(record[key]);
    }
  }

  walk(schema);
  return found;
}

type CollectedNode = Readonly<{
  operationId: string;
  slot: string;
  node: Record<string, unknown>;
}>;

function isMapNode(node: Record<string, unknown>): boolean {
  const additional = node.additionalProperties;
  return (
    additional !== null &&
    typeof additional === "object" &&
    !Array.isArray(additional) &&
    Object.keys(additional as Record<string, unknown>).length > 0 &&
    !Object.hasOwn(node, "properties")
  );
}

function unknownKeyOffenders(
  collected: readonly CollectedNode[],
): readonly string[] {
  return collected
    .filter(
      ({ node }) => node.additionalProperties !== false && !isMapNode(node),
    )
    .map(({ operationId, slot }) => `${operationId}.${slot}`);
}

function collectFixture(
  operationId: string,
  slot: string,
  schema: unknown,
): readonly CollectedNode[] {
  return objectNodes(schema).map((node) => ({ operationId, slot, node }));
}

describe("src/http/contract/coverage.test", () => {
  it("every closed object node in every registered schema forbids an unknown key", () => {
    const collected: CollectedNode[] = [];

    for (const entry of registry) {
      const slots: readonly [
        "query" | "request" | "response",
        "input" | "output",
      ][] = [
        ["query", "input"],
        ["request", "input"],
        ["response", "output"],
      ];
      for (const [slot, io] of slots) {
        const schema = entry[slot];
        if (schema === undefined) continue;
        const jsonSchema = z.toJSONSchema(schema, {
          target: "openapi-3.0",
          io,
        });
        for (const node of objectNodes(jsonSchema)) {
          collected.push({ operationId: entry.operationId, slot, node });
        }
      }
    }

    assert.ok(
      collected.length > 0,
      "expected at least one object node across the registry",
    );

    assert.deepEqual(unknownKeyOffenders(collected), []);
  });

  it("exactly one registered object node is exempt as a map, and it is the provider.loginStart answers record", () => {
    const exempt: { label: string; node: Record<string, unknown> }[] = [];

    for (const entry of registry) {
      const slots: readonly [
        "query" | "request" | "response",
        "input" | "output",
      ][] = [
        ["query", "input"],
        ["request", "input"],
        ["response", "output"],
      ];
      for (const [slot, io] of slots) {
        const schema = entry[slot];
        if (schema === undefined) continue;
        const jsonSchema = z.toJSONSchema(schema, {
          target: "openapi-3.0",
          io,
        });
        for (const node of objectNodes(jsonSchema)) {
          if (node.additionalProperties === false) continue;
          exempt.push({ label: `${entry.operationId}.${slot}`, node });
        }
      }
    }

    assert.deepEqual(
      exempt.map((entry) => entry.label),
      ["provider.loginStart.request"],
    );
    assert.deepEqual(exempt[0]?.node, {
      type: "object",
      additionalProperties: { type: "string" },
    });
  });

  it("the map exemption still reports a fully open object node", () => {
    assert.deepEqual(
      unknownKeyOffenders(
        collectFixture("fixture.openWithProperties", "request", {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: {},
        }),
      ),
      ["fixture.openWithProperties.request"],
    );

    assert.deepEqual(
      unknownKeyOffenders(
        collectFixture("fixture.openCatchall", "request", {
          type: "object",
          additionalProperties: {},
        }),
      ),
      ["fixture.openCatchall.request"],
    );

    assert.deepEqual(
      unknownKeyOffenders(
        collectFixture("fixture.openAbsent", "response", {
          type: "object",
          properties: { name: { type: "string" } },
        }),
      ),
      ["fixture.openAbsent.response"],
    );

    assert.deepEqual(
      unknownKeyOffenders(
        collectFixture("fixture.nestedOpen", "response", {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: { name: { type: "string" } },
              additionalProperties: {},
            },
          },
          additionalProperties: false,
        }),
      ),
      ["fixture.nestedOpen.response"],
    );

    assert.deepEqual(
      unknownKeyOffenders(
        collectFixture("fixture.closedWithMap", "request", {
          type: "object",
          properties: {
            answers: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          additionalProperties: false,
        }),
      ),
      [],
    );
  });

  it("every z.enum argument in src/http/contract/ traces to a domain/ import, and no restated literal or blob-hash pattern exists", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort((a, b) =>
        Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
      );

    for (const file of files) {
      const contents = readFileSync(`${dir}${file}`, "utf8");

      const contentsWithoutAllowedInlineEnums =
        file === "credential.ts"
          ? contents
              .replace(/z\.enum\(\s*\[\s*"true"\s*,\s*"false"\s*\]\s*\)/, "")
              .replace(
                /export const providerVerifyResponse = z\.strictObject\(\{[\s\S]*?\n\}\);\n/,
                "",
              )
          : contents;
      assert.doesNotMatch(
        contentsWithoutAllowedInlineEnums,
        /z\.enum\(\s*\[/,
        `${file} declares an inline z.enum([...]) literal instead of importing a domain/ array`,
      );

      assert.doesNotMatch(
        contents,
        /z\.string\(\)\.regex\(\s*\/\^sha256:/,
        `${file} restates the blob-hash pattern instead of importing blobHash`,
      );

      const imported = new Set<string>();
      for (const match of contents.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g,
      )) {
        const [, names, path] = match;
        if (path === undefined || !/^\.\.\/\.\.\/domain\//.test(path)) continue;
        for (const rawName of (names ?? "").split(",")) {
          const trimmed = rawName.trim();
          if (trimmed === "") continue;
          const asMatch = /\bas\s+(\S+)$/.exec(trimmed);
          const localName = asMatch?.[1] ?? trimmed.split(/\s+/)[0];
          if (localName !== undefined) imported.add(localName);
        }
      }

      for (const match of contents.matchAll(
        /z\.enum\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
      )) {
        const identifier = match[1];
        assert.ok(identifier !== undefined);
        assert.ok(
          imported.has(identifier),
          `${file} calls z.enum(${identifier}) but does not import ${identifier} from a domain/ module`,
        );
        assert.doesNotMatch(
          contents,
          new RegExp(`(const|let|var)\\s+${identifier}\\s*=`),
          `${file} declares ${identifier} locally instead of importing it from domain/`,
        );
      }
    }

    const systemFile = readFileSync(`${dir}system.ts`, "utf8");
    assert.match(
      systemFile,
      /import\s*\{[^}]*\bnodeKind\b[^}]*\}\s*from\s*"\.\.\/\.\.\/domain\/state\.ts"/,
      "system.ts must import nodeKind from ../../domain/state.ts",
    );
    assert.match(
      systemFile,
      /import\s*\{[^}]*\bnodeState\b[^}]*\}\s*from\s*"\.\.\/\.\.\/domain\/state\.ts"/,
      "system.ts must import nodeState from ../../domain/state.ts",
    );
    assert.match(
      systemFile,
      /import\s*\{[^}]*\bblockReason\b[^}]*\}\s*from\s*"\.\.\/\.\.\/domain\/state\.ts"/,
      "system.ts must import blockReason from ../../domain/state.ts",
    );
  });

  it("every field in the registry answers required, nullability and enum, matching the reviewed fixture", () => {
    function fieldRows(label: string, schema: unknown): readonly string[] {
      const rows: string[] = [];

      function walk(
        pointer: string,
        node: unknown,
        requiredHere: boolean,
        emit: boolean,
      ): void {
        if (node === null || typeof node !== "object") return;
        const record = node as Record<string, unknown>;

        if (emit) {
          const nullable = record.nullable === true;
          const enumVal = record.enum;
          const enumStr = Array.isArray(enumVal) ? enumVal.join(",") : "-";
          rows.push(
            `${pointer} required=${requiredHere} nullable=${nullable} enum=${enumStr}`,
          );
        }

        if (
          record.properties !== null &&
          typeof record.properties === "object" &&
          !Array.isArray(record.properties)
        ) {
          const props = record.properties as Record<string, unknown>;
          const required = Array.isArray(record.required)
            ? (record.required as string[])
            : [];
          const keys = Object.keys(props).sort((a, b) =>
            Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
          );
          for (const key of keys) {
            walk(
              `${pointer}/properties/${key}`,
              props[key],
              required.includes(key),
              true,
            );
          }
        }
        if (record.items !== undefined) {
          walk(`${pointer}/items`, record.items, requiredHere, false);
        }
        if (
          record.additionalProperties !== undefined &&
          typeof record.additionalProperties === "object" &&
          record.additionalProperties !== null
        ) {
          walk(
            `${pointer}/additionalProperties`,
            record.additionalProperties,
            requiredHere,
            false,
          );
        }
        for (const key of ["anyOf", "oneOf", "allOf"] as const) {
          const arr = record[key];
          if (Array.isArray(arr)) {
            arr.forEach((item, index) => {
              walk(`${pointer}/${key}/${index}`, item, requiredHere, false);
            });
          }
        }
      }

      walk(label, schema, false, false);
      return rows;
    }

    const rows: string[] = [];
    for (const entry of registry) {
      const slots: readonly [
        "query" | "request" | "response",
        "input" | "output",
      ][] = [
        ["query", "input"],
        ["request", "input"],
        ["response", "output"],
      ];
      for (const [slot, io] of slots) {
        const schema = entry[slot];
        if (schema === undefined) continue;
        const jsonSchema = z.toJSONSchema(schema, {
          target: "openapi-3.0",
          io,
        });
        rows.push(...fieldRows(`${entry.operationId}.${slot}#`, jsonSchema));
      }
    }
    rows.sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
    );

    assert.deepEqual(rows, fieldDecisions);
  });

  it("the reviewed field-decision coverage has no redundant derivation script", () => {
    assert.equal(
      existsSync(
        new URL("../../../scripts/derive-field-decisions.mjs", import.meta.url),
      ),
      false,
    );
  });

  it("no route returns a token except actor.register and actor.rotate", () => {
    function holdsTokenProperty(schema: unknown): boolean {
      if (schema === null || typeof schema !== "object") return false;
      const record = schema as Record<string, unknown>;
      if (
        record.properties !== null &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
      ) {
        const props = record.properties as Record<string, unknown>;
        if (Object.hasOwn(props, "token")) return true;
        for (const value of Object.values(props)) {
          if (holdsTokenProperty(value)) return true;
        }
      }
      if (record.items !== undefined && holdsTokenProperty(record.items)) {
        return true;
      }
      if (
        record.additionalProperties !== undefined &&
        typeof record.additionalProperties === "object" &&
        record.additionalProperties !== null &&
        holdsTokenProperty(record.additionalProperties)
      ) {
        return true;
      }
      for (const key of ["anyOf", "oneOf", "allOf"] as const) {
        const arr = record[key];
        if (Array.isArray(arr) && arr.some(holdsTokenProperty)) return true;
      }
      return false;
    }

    const withToken = registry
      .filter((entry) => {
        if (entry.response === undefined) return false;
        const jsonSchema = z.toJSONSchema(entry.response, {
          target: "openapi-3.0",
          io: "output",
        });
        return holdsTokenProperty(jsonSchema);
      })
      .map((entry) => entry.operationId)
      .sort();
    assert.deepEqual(withToken, ["actor.register", "actor.rotate"]);
  });

  it("every phase-1 routed operation declares errors as a superset of baselineErrors, and only the named operations add codes", () => {
    const baselineCodes = Object.keys(baselineErrors).sort();

    for (const entry of registry) {
      if (entry.introducedIn !== "phase-1" || entry.status !== "routed") {
        continue;
      }

      assert.ok(
        entry.errors !== undefined,
        `${entry.operationId} declares no errors`,
      );
      const declared = Object.keys(entry.errors ?? {});

      for (const code of declared) {
        assert.ok(
          Object.hasOwn(errorStatuses, code),
          `${entry.operationId} declares ${code}, which is not a key of errorStatuses`,
        );
      }

      for (const code of baselineCodes) {
        assert.ok(
          declared.includes(code),
          `${entry.operationId} is missing baseline code ${code}`,
        );
      }

      const extra = declared
        .filter((code) => !baselineCodes.includes(code))
        .sort();
      const expectedExtra = [
        ...(operationAdditions[entry.operationId] ?? []),
      ].sort();
      assert.deepEqual(
        extra,
        expectedExtra,
        `${entry.operationId} declares an unexpected error-code addition`,
      );
    }
  });

  it("every one of the thirty-nine phase-1 routed operations but blob.show carries a response schema", () => {
    assert.equal(scoped.length, 39);
    for (const entry of scoped) {
      assert.ok(
        entry.response !== undefined,
        `${entry.operationId} carries no response schema`,
      );
    }
  });

  it("blob.show and provider.loginCancel are the routed operations with no response schema", () => {
    const missing = registry
      .filter(
        (entry) => entry.status === "routed" && entry.response === undefined,
      )
      .map((entry) => entry.operationId);
    assert.deepEqual(missing, ["blob.show", "provider.loginCancel"]);
  });

  it("every phase-1 routed operation but blob.show carries an example set", () => {
    for (const entry of scoped) {
      assert.ok(
        entry.examples !== undefined,
        `${entry.operationId} carries no example set`,
      );
    }
  });

  it("a stubbed operation declares no schema, no example and no errors", () => {
    const stubbed = registry.filter((entry) => entry.status === "stubbed");
    assert.equal(stubbed.length, 25);
    for (const entry of stubbed) {
      assert.equal(
        entry.query,
        undefined,
        `${entry.operationId} declares query`,
      );
      assert.equal(
        entry.request,
        undefined,
        `${entry.operationId} declares request`,
      );
      assert.equal(
        entry.response,
        undefined,
        `${entry.operationId} declares response`,
      );
      assert.equal(
        entry.examples,
        undefined,
        `${entry.operationId} declares examples`,
      );
      assert.equal(
        entry.errors,
        undefined,
        `${entry.operationId} declares errors`,
      );
    }
  });

  it("every phase-1 routed operation declares errors, blob.show included", () => {
    for (const entry of [
      ...scoped,
      ...registry.filter((entry) => entry.operationId === "blob.show"),
    ]) {
      assert.ok(
        entry.errors !== undefined,
        `${entry.operationId} declares no errors`,
      );
    }
  });

  it("a 501 body still parses against the baseline envelope", () => {
    assert.doesNotThrow(() =>
      buildErrorEnvelope(baselineErrors).parse({
        error: { code: "not-implemented", message: "not implemented" },
      }),
    );
  });

  it("the outside-writer refusal stays unreachable", () => {
    const dir = new URL("../../../", import.meta.url).pathname;
    const roots = ["src/commands", "src/http/server"];
    const pattern = /new RegisterRepositoryError\(\s*\n?\s*"outside-writer"/;

    function walk(current: string): readonly string[] {
      const found: string[] = [];
      for (const name of readdirSync(current, { withFileTypes: true })) {
        const full = `${current}/${name.name}`;
        if (name.isDirectory()) {
          found.push(...walk(full));
        } else if (
          name.name.endsWith(".ts") &&
          !name.name.endsWith(".test.ts")
        ) {
          found.push(full);
        }
      }
      return found;
    }

    for (const root of roots) {
      for (const file of walk(`${dir}${root}`)) {
        const contents = readFileSync(file, "utf8");
        assert.doesNotMatch(
          contents,
          pattern,
          `${file} constructs the outside-writer refusal, which must stay unreachable`,
        );
      }
    }
  });

  it("after and limit are declared exactly once, in cursor.ts", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort((a, b) =>
        Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
      );

    const afterFiles = files.filter((file) =>
      /^\s*after:/m.test(readFileSync(`${dir}${file}`, "utf8")),
    );
    const limitFiles = files.filter((file) =>
      /^\s*limit:/m.test(readFileSync(`${dir}${file}`, "utf8")),
    );

    assert.deepEqual(afterFiles, ["cursor.ts"]);
    assert.deepEqual(limitFiles, ["cursor.ts"]);
  });

  it("every paging schema derives from cursorRequest", () => {
    const cursorSchema = z.toJSONSchema(cursorRequest, {
      target: "openapi-3.0",
      io: "input",
    }) as { properties?: Record<string, unknown> };
    const cursorProperties = cursorSchema.properties ?? {};

    for (const entry of registry) {
      if (entry.query === undefined) continue;
      const querySchema = z.toJSONSchema(entry.query, {
        target: "openapi-3.0",
        io: "input",
      }) as { properties?: Record<string, unknown> };
      const properties = querySchema.properties ?? {};
      assert.equal(
        properties.after !== undefined,
        properties.limit !== undefined,
        `${entry.operationId}.query declares after/limit inconsistently`,
      );
      for (const name of ["after", "limit"] as const) {
        if (properties[name] === undefined) continue;
        assert.deepEqual(
          properties[name],
          cursorProperties[name],
          `${entry.operationId}.query.${name} drifts from cursorRequest`,
        );
      }
    }
  });
});

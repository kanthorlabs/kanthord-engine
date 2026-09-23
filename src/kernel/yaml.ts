import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { Diagnostic } from "./errors.ts";
import { isObject } from "./values.ts";

const EXHAUSTED_NODE_BUDGET = 0;
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_CONFIG_NODES = 4096;
export const MAX_CONFIG_DEPTH = 32;

export function inspectTree(
  value: unknown,
  budget: { remaining: number },
  ancestors: ReadonlySet<object>,
): void {
  assert.ok(
    budget.remaining >= EXHAUSTED_NODE_BUDGET &&
      budget.remaining <= MAX_CONFIG_NODES,
  );
  assert.ok(ancestors.size <= MAX_CONFIG_DEPTH);
  if (budget.remaining === EXHAUSTED_NODE_BUDGET)
    throw new Diagnostic(
      "system.config.too_many_values",
      "configuration: too many values.",
    );
  budget.remaining--;
  if (!isObject(value)) return;
  if (ancestors.has(value))
    throw new Diagnostic(
      "system.config.cyclic_alias",
      "configuration: cyclic aliases are not allowed.",
    );
  if (ancestors.size === MAX_CONFIG_DEPTH)
    throw new Diagnostic(
      "system.config.too_deep",
      "configuration: nesting is too deep.",
    );
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw new Diagnostic(
      "system.config.invalid_mapping",
      "configuration: expected a plain mapping or array.",
    );
  const children: unknown[] = Object.values(value);
  if (children.length > budget.remaining)
    throw new Diagnostic(
      "system.config.too_many_values",
      "configuration: too many values.",
    );
  const parents = new Set(ancestors).add(value);
  for (const child of children) inspectTree(child, budget, parents);
}

export function parseMapping(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES)
    throw new Diagnostic(
      "system.config.too_large",
      "configuration: YAML exceeds the 1 MiB limit.",
    );
  const document = parseDocument(source, {
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
  });
  assert.equal(document.options.stringKeys, true);
  assert.equal(document.options.uniqueKeys, true);
  if (document.errors.length || document.warnings.length)
    throw new Diagnostic(
      "system.config.invalid_yaml",
      "configuration: expected one valid YAML mapping with unique string keys.",
    );
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new Diagnostic(
      "system.config.invalid_yaml",
      "configuration: invalid YAML mapping.",
    );
  }
  inspectTree(value, { remaining: MAX_CONFIG_NODES }, new Set());
  if (!isObject(value) || Array.isArray(value))
    throw new Diagnostic(
      "system.config.invalid_mapping",
      "configuration: expected one YAML mapping.",
    );
  return value as Record<string, unknown>;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMapping } from "./yaml.ts";

const YAML_VALUE = "ok";
const MAX_SEQUENCE_ENTRIES = 4094;

test("YAML rejects duplicate keys, extra documents, malformed secrets, arrays, and non-mappings without excerpts", () => {
  for (const source of [
    "master_key: secret-marker\nmaster_key: again",
    "a: 1\n---\nb: 2",
    "master_key: [secret-marker",
    "- secret-marker",
    "null",
  ]) {
    assert.throws(
      () => parseMapping(source),
      (error: Error) => {
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  }
});

test("bounded YAML retains ordinary aliases and rejects unsafe tags and unresolved aliases", () => {
  const value = parseMapping("first: &hosts [localhost]\nsecond: *hosts");
  assert.deepEqual(value.first, ["localhost"]);
  assert.equal(value.first, value.second);
  for (const source of [
    "value: !secret-marker text",
    "value: *secret-marker",
    "!!set {secret-marker: null}",
    "value: &cycle {self: *cycle}",
    "? [secret-marker, test]\n: 1",
  ]) {
    assert.throws(
      () => parseMapping(source),
      (error: Error) => {
        assert.match(error.message, /configuration:/);
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  }
});

test("YAML enforces byte, expanded-value, and nesting limits", () => {
  const atByteLimit = "value: ok\n#".padEnd(1024 * 1024, "x");
  assert.equal(parseMapping(atByteLimit).value, YAML_VALUE);
  assert.throws(() => parseMapping(atByteLimit + "x"), /1 MiB limit/);
  assert.throws(
    () => parseMapping("value: " + "é".repeat(512 * 1024)),
    /1 MiB limit/,
  );
  const atNodeLimit = `values: [${Array<string>(4094).fill("x").join(",")}]`;
  assert.equal(
    (parseMapping(atNodeLimit).values as string[]).length,
    MAX_SEQUENCE_ENTRIES,
  );
  assert.throws(
    () => parseMapping(atNodeLimit.replace("]", ",x]")),
    /too many values/,
  );
  const atDepthLimit = '{"nested":'.repeat(32) + "0" + "}".repeat(32);
  assert.doesNotThrow(() => parseMapping(atDepthLimit));
  assert.throws(
    () => parseMapping(`{nested: ${atDepthLimit}}`),
    /nesting is too deep/,
  );
});

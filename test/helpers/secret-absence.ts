import assert from "node:assert/strict";

export function assertSerializedSecretsAbsent(
  values: readonly unknown[],
  secrets: readonly string[],
): void {
  const serialized = values.map((value) => JSON.stringify(value)).join("\n");
  for (const secret of secrets) {
    assert.equal(
      serialized.includes(secret),
      false,
      `serialized output contains fixture secret ${secret}`,
    );
  }
}

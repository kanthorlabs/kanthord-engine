import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Linter } from "eslint";

const compositionRuleConfig: Linter.Config[] = [
  {
    files: ["*.ts"],
    ignores: [],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'MemberExpression > Identifier.property[name="composition"]',
          message:
            "Read .metadata.composition only in the three permitted files.",
        },
        {
          selector:
            'MemberExpression[computed=true] > Literal.property[value="composition"]',
          message: 'Read ["composition"] only in the three permitted files.',
        },
      ],
    },
  },
];

const linter = new Linter({ configType: "flat" });

function verify(source: string): Linter.LintMessage[] {
  return linter.verify(source, compositionRuleConfig, { filename: "test.ts" });
}

describe("src/domain/worker-registry-lint", () => {
  it("reports a direct composition member read", () => {
    assert.deepEqual(
      verify("const x = entry.metadata.composition;").map(
        ({ ruleId }) => ruleId,
      ),
      ["no-restricted-syntax"],
    );
  });

  it("reports a bracket composition member read", () => {
    assert.deepEqual(
      verify('const x = entry.metadata["composition"];').map(
        ({ ruleId }) => ruleId,
      ),
      ["no-restricted-syntax"],
    );
  });

  it("permits a different metadata member read", () => {
    assert.deepEqual(verify("const x = entry.metadata.driver;"), []);
  });

  it("does not absorb the independent node write restriction", () => {
    const nodeWriteSource = 'const q = "INSERT INTO ' + 'node VALUES (1);";';

    assert.deepEqual(verify(nodeWriteSource), []);
  });
});

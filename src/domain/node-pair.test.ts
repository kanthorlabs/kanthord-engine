import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverables } from "./deliverable.ts";
import { nodePairLegality, type NodePairLegal } from "./node-pair.ts";
import { nodeKinds } from "./state.ts";

describe("src/domain/node-pair.ts", () => {
  it("enumerates eight legal and four illegal pairs", () => {
    let legalCount = 0;
    let illegalCount = 0;

    for (const kind of nodeKinds) {
      for (const deliverable of deliverables) {
        if (nodePairLegality(kind, deliverable).legal) {
          legalCount += 1;
        } else {
          illegalCount += 1;
        }
      }
    }

    assert.strictEqual(legalCount, 8);
    assert.strictEqual(illegalCount, 4);
  });

  it("returns the complete shape and state owner for every legal pair", () => {
    const expected = new Map<string, NodePairLegal>([
      [
        "initiative:expansion",
        { legal: true, shape: "parent", stateOwner: "aggregate" },
      ],
      [
        "objective:expansion",
        { legal: true, shape: "parent", stateOwner: "aggregate" },
      ],
      [
        "objective:test",
        {
          legal: true,
          shape: "atomic",
          stateOwner: "attestation-then-human",
        },
      ],
      [
        "objective:implementation",
        {
          legal: true,
          shape: "atomic",
          stateOwner: "attestation-then-human",
        },
      ],
      [
        "objective:review",
        {
          legal: true,
          shape: "atomic",
          stateOwner: "attestation-then-human",
        },
      ],
      ["task:test", { legal: true, shape: "atomic", stateOwner: "report" }],
      [
        "task:implementation",
        { legal: true, shape: "atomic", stateOwner: "report" },
      ],
      ["task:review", { legal: true, shape: "atomic", stateOwner: "report" }],
    ]);

    for (const kind of nodeKinds) {
      for (const deliverable of deliverables) {
        const result = nodePairLegality(kind, deliverable);
        if (result.legal) {
          assert.deepStrictEqual(
            result,
            expected.get(`${kind}:${deliverable}`),
          );
        }
      }
    }
  });

  it("refuses each illegal pair by value", () => {
    const refusal = { legal: false, refusal: "pair-illegal" };

    assert.deepStrictEqual(nodePairLegality("initiative", "test"), refusal);
    assert.deepStrictEqual(
      nodePairLegality("initiative", "implementation"),
      refusal,
    );
    assert.deepStrictEqual(nodePairLegality("initiative", "review"), refusal);
    assert.deepStrictEqual(nodePairLegality("task", "expansion"), refusal);
  });
});

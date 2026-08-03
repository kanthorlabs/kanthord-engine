import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { agentKinds, agentKind } from "./agent.ts";

describe("src/domain/agent.test", () => {
  it("agentKinds deep-equals the expected array", () => {
    assert.deepEqual(agentKinds, ["general@1", "swe@1", "te@1", "re@1"]);
  });

  it("agentKind.options deep-equals the expected array", () => {
    assert.deepEqual(agentKind.options, ["general@1", "swe@1", "te@1", "re@1"]);
  });

  for (const kind of ["general@1", "swe@1", "te@1", "re@1"] as const) {
    it(`agentKind.safeParse accepts "${kind}"`, () => {
      assert.equal(agentKind.safeParse(kind).success, true);
    });
  }

  for (const value of ["tdd@1", "git@1", "re", "re@2", ""] as const) {
    it(`agentKind.safeParse rejects "${value}"`, () => {
      assert.equal(agentKind.safeParse(value).success, false);
    });
  }

  it("agent_invocation DDL CHECK clause matches the enum", () => {
    const ddl = readFileSync(
      resolve(
        import.meta.dirname!,
        "../../docs/proposal/database/agent_invocation.md",
      ),
      "utf-8",
    );
    assert.ok(
      ddl.includes("CHECK (agent IN ('general@1', 'swe@1', 'te@1', 're@1'))"),
      "agent_invocation.md must contain the exact CHECK clause matching the agentKind enum",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const docs = resolve(import.meta.dirname, "../../../docs/proposal");

function read(relative: string): string {
  return readFileSync(resolve(docs, relative), "utf8");
}

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const instruction = squash(read("api/instruction.md"));

describe("src/http/contract/proposal-amendment-instruction.test", () => {
  it("agent.list documents all four published contracts without deferred markers", () => {
    const start = instruction.indexOf("## `agent.list`");
    assert.notEqual(start, -1, "missing the agent.list section");
    const afterHeading = instruction.slice(start);
    const end = afterHeading.indexOf("## The profile lives in the database");
    const agentList = end === -1 ? afterHeading : afterHeading.slice(0, end);

    assert.equal(
      agentList.includes("deferred"),
      false,
      "the deferred-marker claim remains",
    );
    assert.equal(
      agentList.includes("git@1"),
      false,
      "the deferred git role remains",
    );
    for (const field of ["`agent`", "`purpose`", "`capabilities`", "`tools`"]) {
      assert.ok(agentList.includes(field), `${field} is not documented`);
    }
    for (const [agent, purpose] of [
      ["general@1", "Does any task end to end."],
      ["swe@1", "Writes production code. Writes no test."],
      ["te@1", "Writes tests. Writes no production code."],
      ["re@1", "Reviews a diff against acceptance criteria."],
    ] as const) {
      assert.ok(
        agentList.includes(`\`${agent}\``),
        `${agent} is not documented`,
      );
      assert.ok(
        agentList.includes(purpose),
        `${agent} purpose is not documented`,
      );
    }
    assert.ok(
      agentList.includes(
        "`read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`",
      ),
      "the full tool set is not documented",
    );
    assert.ok(
      agentList.includes("`read`, `bash`, `grep`, `find` and `ls`"),
      "the review tool set is not documented",
    );
  });
});

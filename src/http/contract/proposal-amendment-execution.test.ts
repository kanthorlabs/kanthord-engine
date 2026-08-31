import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { transitions } from "../../domain/transition.ts";

const docs = resolve(import.meta.dirname, "../../../docs/proposal");

function read(relative: string): string {
  return readFileSync(resolve(docs, relative), "utf8");
}

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const execution = squash(read("api/execution.md"));
const stateMachine = squash(read("phase-1/state-machine.md"));

const amendedRunningReadyNote =
  "T: recovery finds an expired lease, a clean tree, and the head at the base, or an external harness reports a rejected attempt under the attempt limit, which ends the attempt and returns the task to the pool. A released or expired external claim also returns the task to the pool, and the daemon writes no `dirty-recovery` for a task that has no working tree. O and I: no operation rewinds a running parent to a claimable state.";

describe("src/http/contract/proposal-amendment-execution.test", () => {
  it("the leases-have-no-route section keeps its statement and gains the claim amendment clause", () => {
    assert.ok(
      execution.includes(
        "A lease appears as a field of a node and of a run: the owner, the expiry, and whether it is stale.",
      ),
    );
    assert.ok(
      execution.includes(
        "A separate lease collection would be an internal table promoted to a public resource, and nothing in the proposal asks a human to read one directly.",
      ),
    );
    assert.ok(execution.includes("`system.status` reports the stale ones."));
    assert.ok(
      execution.includes(
        "the lease is still not addressable, and a claim, a heartbeat and a release are actions on the node, spelled `POST /v1/node/:id/claim`, `POST /v1/node/:id/heartbeat` and `POST /v1/node/:id/release`.",
      ),
      "the lease amendment clause is absent",
    );
  });

  it("execution.md gains the objective-scope section with the three sentences", () => {
    assert.ok(
      execution.includes("## The objective scope of a claim"),
      "missing the objective-scope section",
    );
    assert.ok(
      execution.includes(
        "An external claim holds the objective. A task claim holds the objective and the task. Two actors never hold two sibling tasks of one objective.",
      ),
      "the three objective-scope sentences are absent",
    );
  });

  it("worker.list documents both registered workers and the response fields", () => {
    const start = execution.indexOf("## `worker.list`");
    assert.notEqual(start, -1, "missing the worker.list section");
    const afterHeading = execution.slice(start);
    const end = afterHeading.indexOf("## Leases have no route");
    const workerList = end === -1 ? afterHeading : afterHeading.slice(0, end);

    assert.ok(workerList.includes("`claude@1`"), "claude@1 is not documented");
    assert.ok(
      workerList.includes("`opencode@1`"),
      "opencode@1 is not documented",
    );
    assert.equal(
      workerList.includes("general@1 only"),
      false,
      "the obsolete general@1-only response remains",
    );
    for (const field of [
      "`worker`",
      "`driver`",
      "`agents`",
      "`claims`",
      "`deliverables`",
      "`harness`",
      "`metadata.composition`",
    ]) {
      assert.ok(workerList.includes(field), `${field} is not documented`);
    }
  });

  it("state-machine.md line 78 carries the amended running-ready note", () => {
    assert.ok(
      stateMachine.includes(amendedRunningReadyNote),
      "the running to ready note is not amended",
    );
  });

  it("transition.ts carries the identical amended note and an unchanged row shape", () => {
    const row = transitions.find(
      (entry) => entry.from === "running" && entry.to === "ready",
    );
    assert.ok(row, "no running to ready transitions row");
    assert.equal(row.note, amendedRunningReadyNote);
    assert.equal(row.task, true);
    assert.equal(row.objective, false);
    assert.equal(row.initiative, false);
  });
});

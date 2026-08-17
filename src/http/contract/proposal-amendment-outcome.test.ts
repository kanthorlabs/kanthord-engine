import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const docs = resolve(import.meta.dirname, "../../../docs/proposal");

function read(relative: string): string {
  return readFileSync(resolve(docs, relative), "utf8");
}

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const outcome = squash(read("api/outcome.md"));
const stateMachine = squash(read("phase-1/state-machine.md"));
const attempt = squash(read("database/attempt.md"));

const spendClause =
  "Attempt accounting belongs to the domain. The attempt counter is `MAX(attempt_no)` of the active task run. Every closed attempt spends a try, whatever its outcome. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration.";

describe("src/http/contract/proposal-amendment-outcome.test", () => {
  it("outcome.md gains the node.report section before the one-path section", () => {
    assert.ok(
      outcome.includes("## node.report"),
      "missing the node.report section",
    );
    assert.ok(
      outcome.indexOf("## node.report") <
        outcome.indexOf("## One path for abandon"),
      "the node.report section does not sit before the one-path section",
    );
    assert.ok(
      outcome.includes("One route, and the node kind decides the behaviour."),
      "the one-path rule sentence is absent",
    );
  });

  it("the node.report section states the four task outcomes and their transitions", () => {
    assert.ok(
      outcome.includes(
        "A task report carries one of `accepted`, `rejected`, `failed` and `cancelled`.",
      ),
      "the four task outcomes are absent",
    );
    assert.ok(
      outcome.includes(
        "`accepted` moves the task `running → done` and records the reported object id.",
      ),
      "the accepted transition is absent",
    );
    assert.ok(
      outcome.includes(
        "`rejected`, `failed` and `cancelled` close the attempt and return the task to `ready` under the attempt limit, and reach `blocked` with reason `attempt-limit` at the limit.",
      ),
      "the ready and blocked transitions are absent",
    );
    assert.ok(
      outcome.includes(
        "`timed-out` is not a reported outcome, because an external attempt carries no timeout budget.",
      ),
      "the timed-out refusal is absent",
    );
  });

  it("the node.report section states the lease guard and the owner rule", () => {
    assert.ok(
      outcome.includes(
        "A task report requires a live lease on the task: a matching owner, a matching fence and an unexpired row. Every refusal is `409 lease-held`.",
      ),
      "the lease guard sentence is absent",
    );
    assert.ok(
      outcome.includes(
        "The authenticated actor is the owner. The request body carries no owner field.",
      ),
      "the owner rule is absent",
    );
  });

  it("the node.report section states the attestation and the derived close", () => {
    assert.ok(
      outcome.includes(
        "An objective report with `attested` carries the combined object id, moves the objective `running → awaiting_approval` and releases the objective lease. The daemon infers no objective result.",
      ),
      "the attestation sentence is absent",
    );
    assert.ok(
      outcome.includes(
        "An objective report with `closed` carries `acknowledgePartial` only. The daemon derives `done` or `partial` from the task states. A derived `partial` with no acknowledgement is `409 acknowledgement-required`.",
      ),
      "the derived close sentence is absent",
    );
  });

  it("the node.report section states the initiative refusal and the actor admission", () => {
    assert.ok(
      outcome.includes("A report on an initiative is `400 invalid-request`."),
      "the initiative refusal is absent",
    );
    assert.ok(
      outcome.includes(
        "A task report admits a `harness` actor, an attestation admits a `harness` actor, and a close admits a `human` actor.",
      ),
      "the actor admission sentence is absent",
    );
  });

  it("state-machine.md line 118 carries the spend clause and drops the rejection-only clause", () => {
    assert.ok(
      stateMachine.includes(spendClause),
      "the spend clause is not in state-machine.md",
    );
    assert.ok(
      !stateMachine.includes("Each rejection increments the attempt counter."),
      "the rejection-only clause still reads",
    );
  });

  it("attempt.md prose widens the limit clause to any non-null outcome", () => {
    assert.ok(
      attempt.includes(
        "`attempt_no = attempt_limit` with any non-null `outcome` moves the task to `blocked` with reason `attempt-limit`.",
      ),
      "the widened limit clause is not in attempt.md",
    );
    assert.ok(
      !attempt.includes(
        "with an `outcome` of `rejected` moves the task to `blocked`",
      ),
      "the rejected-only limit clause still reads",
    );
  });
});

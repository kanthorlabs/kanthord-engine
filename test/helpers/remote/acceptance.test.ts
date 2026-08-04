import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixtureError, runAcceptance } from "./acceptance.ts";

describe("test/helpers/remote/acceptance.test", () => {
  it("resolves when every check passes", async () => {
    await runAcceptance("x", 1, [{ name: "a", run() {} }]);
  });

  it("awaits the checks in array order including an async one", async () => {
    const order: string[] = [];
    await runAcceptance("x", 1, [
      {
        name: "a",
        run() {
          order.push("a");
        },
      },
      {
        name: "b",
        async run() {
          await Promise.resolve();
          order.push("b");
        },
      },
      {
        name: "c",
        run() {
          order.push("c");
        },
      },
    ]);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("rejects with FixtureError naming the single failed check and its reason", async () => {
    await assert.rejects(
      runAcceptance("x", 1, [
        { name: "a", run() {} },
        {
          name: "b",
          run() {
            throw new Error("boom");
          },
        },
        { name: "c", run() {} },
      ]),
      (error) => {
        if (!(error instanceof FixtureError)) return false;
        assert.deepEqual(error.failures, [{ name: "b", reason: "boom" }]);
        assert.equal(error.message, "x failed 1 of 3 acceptance checks: b");
        return true;
      },
    );
  });

  it("reports every throwing check in list order, not just the first", async () => {
    await assert.rejects(
      runAcceptance("x", 1, [
        { name: "a", run() {} },
        {
          name: "b",
          run() {
            throw new Error("boom");
          },
        },
        {
          name: "c",
          run() {
            throw new Error("crash");
          },
        },
      ]),
      (error) => {
        if (!(error instanceof FixtureError)) return false;
        assert.deepEqual(error.failures, [
          { name: "b", reason: "boom" },
          { name: "c", reason: "crash" },
        ]);
        assert.equal(error.message, "x failed 2 of 3 acceptance checks: b, c");
        return true;
      },
    );
  });

  it("records the string form of a non-Error throw as the reason", async () => {
    await assert.rejects(
      runAcceptance("x", 1, [
        {
          name: "a",
          run() {
            throw 17;
          },
        },
      ]),
      (error) => {
        if (!(error instanceof FixtureError)) return false;
        assert.deepEqual(error.failures, [{ name: "a", reason: "17" }]);
        return true;
      },
    );
  });

  it("rejects an empty check list as a failure instead of passing", async () => {
    await assert.rejects(runAcceptance("x", 1, []), (error) => {
      if (!(error instanceof FixtureError)) return false;
      assert.ok(error.message.includes("the check list is empty"));
      return true;
    });
  });

  it("is a real Error class carrying the recorded failures", () => {
    const error = new FixtureError("x", [{ name: "a", reason: "boom" }]);
    assert.ok(error instanceof Error);
    assert.ok(error instanceof FixtureError);
    assert.deepEqual(error.failures, [{ name: "a", reason: "boom" }]);
  });

  it("builds the identical message directly constructed and thrown by runAcceptance", async () => {
    const checks = [
      { name: "a", run() {} },
      {
        name: "b",
        run() {
          throw new Error("boom");
        },
      },
      {
        name: "c",
        run() {
          throw new Error("crash");
        },
      },
    ];
    const thrown = await runAcceptance("x", 1, checks).then(
      () => {
        throw new Error("expected runAcceptance to reject");
      },
      (error: unknown) => error,
    );
    assert.ok(thrown instanceof FixtureError);
    assert.equal(thrown.message, "x failed 2 of 3 acceptance checks: b, c");

    const constructed = new FixtureError("x", thrown.failures, checks.length);
    assert.equal(constructed.message, thrown.message);
  });

  it("keeps the empty-list message on a directly constructed error with zero checks", () => {
    const error = new FixtureError(
      "x",
      [{ name: "acceptance", reason: "the check list is empty" }],
      0,
    );
    assert.ok(error.message.includes("the check list is empty"));
  });
});

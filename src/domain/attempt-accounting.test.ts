import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  accountAttempts,
  attemptVerdict,
  AttemptAccountingError,
} from "./attempt-accounting.ts";
import type {
  AttemptRecord,
  AttemptAccounting,
  AttemptVerdict,
} from "./attempt-accounting.ts";
import { canTransition } from "./transition.ts";
import { blockReasons } from "./state.ts";

describe("src/domain/attempt-accounting", () => {
  it("empty, limit 3", () => {
    assert.deepEqual(accountAttempts({ attempts: [], limit: 3 }), {
      counter: 0,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 1,
    });
  });

  it("[1 rejected], limit 3", () => {
    const attempts: AttemptRecord[] = [{ attemptNo: 1, outcome: "rejected" }];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 1,
      rejections: 1,
      exhausted: false,
      nextAttemptNo: 2,
    });
  });

  it("[1 rejected, 2 rejected], limit 3", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "rejected" },
      { attemptNo: 2, outcome: "rejected" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 2,
      rejections: 2,
      exhausted: false,
      nextAttemptNo: 3,
    });
  });

  it("the normative case: [1 rejected, 2 rejected, 3 rejected], limit 3", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "rejected" },
      { attemptNo: 2, outcome: "rejected" },
      { attemptNo: 3, outcome: "rejected" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 3,
      exhausted: true,
      nextAttemptNo: 4,
    });
  });

  it("a failure at the limit does not block: [1 failed, 2 failed, 3 failed], limit 3", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "failed" },
      { attemptNo: 2, outcome: "failed" },
      { attemptNo: 3, outcome: "failed" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("timed-out at the limit does not block", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "timed-out" },
      { attemptNo: 2, outcome: "timed-out" },
      { attemptNo: 3, outcome: "timed-out" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("cancelled at the limit does not block", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "cancelled" },
      { attemptNo: 2, outcome: "cancelled" },
      { attemptNo: 3, outcome: "cancelled" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("accepted at the limit does not block", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "accepted" },
      { attemptNo: 2, outcome: "accepted" },
      { attemptNo: 3, outcome: "accepted" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("null (pending) at the limit does not block", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "failed" },
      { attemptNo: 2, outcome: "failed" },
      { attemptNo: 3, outcome: null },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("a rejection at the limit blocks even with earlier failures", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "failed" },
      { attemptNo: 2, outcome: "failed" },
      { attemptNo: 3, outcome: "rejected" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 1,
      exhausted: true,
      nextAttemptNo: 4,
    });
  });

  it("three rejections below the limit do not block", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "rejected" },
      { attemptNo: 2, outcome: "rejected" },
      { attemptNo: 3, outcome: "rejected" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 4 }), {
      counter: 3,
      rejections: 3,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("a pending attempt at the limit does not block", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "rejected" },
      { attemptNo: 2, outcome: "rejected" },
      { attemptNo: 3, outcome: null },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 2,
      exhausted: false,
      nextAttemptNo: 4,
    });
  });

  it("overshoot: [1 rejected, 2 rejected, 3 rejected, 4 rejected], limit 3", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 1, outcome: "rejected" },
      { attemptNo: 2, outcome: "rejected" },
      { attemptNo: 3, outcome: "rejected" },
      { attemptNo: 4, outcome: "rejected" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 4,
      rejections: 4,
      exhausted: true,
      nextAttemptNo: 5,
    });
  });

  it("the last attempt decides, not the array position", () => {
    const attempts: AttemptRecord[] = [
      { attemptNo: 3, outcome: "rejected" },
      { attemptNo: 1, outcome: "failed" },
      { attemptNo: 2, outcome: "failed" },
    ];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 3,
      rejections: 1,
      exhausted: true,
      nextAttemptNo: 4,
    });
  });

  it("reversed array gives identical result", () => {
    const forward: AttemptRecord[] = [
      { attemptNo: 1, outcome: "failed" },
      { attemptNo: 2, outcome: "failed" },
      { attemptNo: 3, outcome: "rejected" },
    ];
    const reverse: AttemptRecord[] = [
      { attemptNo: 3, outcome: "rejected" },
      { attemptNo: 2, outcome: "failed" },
      { attemptNo: 1, outcome: "failed" },
    ];
    assert.deepEqual(
      accountAttempts({ attempts: forward, limit: 3 }),
      accountAttempts({ attempts: reverse, limit: 3 }),
    );
  });

  it("a gap does not reissue a number: [2 rejected], limit 3", () => {
    const attempts: AttemptRecord[] = [{ attemptNo: 2, outcome: "rejected" }];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 2,
      rejections: 1,
      exhausted: false,
      nextAttemptNo: 3,
    });
  });

  it("a gap past the limit still blocks: [5 rejected], limit 3", () => {
    const attempts: AttemptRecord[] = [{ attemptNo: 5, outcome: "rejected" }];
    assert.deepEqual(accountAttempts({ attempts, limit: 3 }), {
      counter: 5,
      rejections: 1,
      exhausted: true,
      nextAttemptNo: 6,
    });
  });

  it("limit 1, [1 rejected]: exhausted is true", () => {
    const attempts: AttemptRecord[] = [{ attemptNo: 1, outcome: "rejected" }];
    assert.deepEqual(accountAttempts({ attempts, limit: 1 }), {
      counter: 1,
      rejections: 1,
      exhausted: true,
      nextAttemptNo: 2,
    });
  });

  it("limit 1, [1 failed]: exhausted is false", () => {
    const attempts: AttemptRecord[] = [{ attemptNo: 1, outcome: "failed" }];
    assert.deepEqual(accountAttempts({ attempts, limit: 1 }), {
      counter: 1,
      rejections: 0,
      exhausted: false,
      nextAttemptNo: 2,
    });
  });

  it("limit 0 throws attempt-limit-invalid", () => {
    try {
      accountAttempts({ attempts: [], limit: 0 });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-limit-invalid");
    }
  });

  it("limit -1 throws attempt-limit-invalid", () => {
    try {
      accountAttempts({ attempts: [], limit: -1 });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-limit-invalid");
    }
  });

  it("limit 1.5 throws attempt-limit-invalid", () => {
    try {
      accountAttempts({ attempts: [], limit: 1.5 });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-limit-invalid");
    }
  });

  it("attemptNo 0 throws attempt-no-invalid", () => {
    try {
      accountAttempts({
        attempts: [{ attemptNo: 0, outcome: "rejected" }],
        limit: 3,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-no-invalid");
    }
  });

  it("attemptNo -1 throws attempt-no-invalid", () => {
    try {
      accountAttempts({
        attempts: [{ attemptNo: -1, outcome: "rejected" }],
        limit: 3,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-no-invalid");
    }
  });

  it("attemptNo 1.5 throws attempt-no-invalid", () => {
    try {
      accountAttempts({
        attempts: [{ attemptNo: 1.5, outcome: "rejected" }],
        limit: 3,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-no-invalid");
    }
  });

  it("duplicate attemptNo throws attempt-no-duplicate", () => {
    try {
      accountAttempts({
        attempts: [
          { attemptNo: 1, outcome: "rejected" },
          { attemptNo: 1, outcome: "failed" },
        ],
        limit: 3,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-no-duplicate");
      assert.match(e.message, /1/);
    }
  });

  it("limit is validated before attempts", () => {
    try {
      accountAttempts({
        attempts: [{ attemptNo: 0, outcome: null }],
        limit: 0,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AttemptAccountingError);
      assert.equal(e.code, "attempt-limit-invalid");
    }
  });

  it("attemptVerdict with exhausted returns blocked/attempt-limit", () => {
    const accounting: AttemptAccounting = {
      counter: 3,
      rejections: 3,
      exhausted: true,
      nextAttemptNo: 4,
    };
    assert.deepEqual(attemptVerdict(accounting), {
      state: "blocked",
      blockReason: "attempt-limit",
    });
  });

  it("attemptVerdict with not exhausted returns running/null", () => {
    const accounting: AttemptAccounting = {
      counter: 1,
      rejections: 1,
      exhausted: false,
      nextAttemptNo: 2,
    };
    assert.deepEqual(attemptVerdict(accounting), {
      state: "running",
      blockReason: null,
    });
  });

  it("blocked verdict is a legal transition", () => {
    assert.equal(canTransition("task", "running", "blocked"), true);
  });

  it("attempt-limit is a member of blockReasons", () => {
    assert.ok(blockReasons.includes("attempt-limit"));
  });
});

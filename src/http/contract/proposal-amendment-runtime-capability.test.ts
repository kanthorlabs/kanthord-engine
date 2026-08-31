import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const document = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../docs/proposal/phase-1/runtime-capability-matrix.md",
  ),
  "utf8",
);

describe("src/http/contract/proposal-amendment-runtime-capability.test", () => {
  it("records worker-health and the recalculated capability totals", () => {
    assert.match(
      document,
      /^\| `worker-health`\s+\| none\s+\| yes\s+\| yes\s+\| yes\s+\|$/m,
      "the worker-health capability row is absent",
    );
    assert.ok(
      document.includes(
        "Twenty-two capabilities. Fifteen import no Node built-in at all.",
      ),
      "the capability count and built-in total are stale",
    );
    assert.ok(
      document.includes(
        "On Lambda twenty are `yes` and two are `no`, and the two are `home-lock` and `storage`.",
      ),
      "the Lambda capability totals are stale",
    );
    assert.ok(
      document.includes(
        "On Workers eighteen are `yes` and four are `no`, and the four are `config`, `git`, `home-lock` and `storage`.",
      ),
      "the Workers capability totals are stale",
    );
  });

  it("names all five storage-free operations", () => {
    const start = document.indexOf("`Storage` holds `sqlite`");
    assert.notEqual(start, -1, "the storage explanation is absent");
    const end = document.indexOf("\n\n### The aggregate", start);
    assert.notEqual(end, -1, "the storage explanation has no boundary");
    const explanation = document.slice(start, end);

    assert.ok(
      explanation.includes("Five rows hold `-`"),
      "the storage-free count is stale",
    );
    for (const operation of [
      "agent.list",
      "provider.catalog",
      "provider.inspect",
      "system.health",
      "worker.list",
    ]) {
      assert.ok(
        explanation.includes(`\`${operation}\``),
        `${operation} is not named as storage-free`,
      );
    }
    assert.equal(
      explanation.includes("Three rows hold `-`"),
      false,
      "the old storage-free count remains",
    );
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { cliDecision, parseArguments, releaseVerdict } from "./release-gate.ts";
import type { ReleaseFacts } from "./release-gate.ts";

test("scripts/release-gate", async (t) => {
  await t.test("accepts a clean tree with the matching release tag", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: true,
      tag: "v27.8.1",
    });
  });

  await t.test("refuses a clean tree with no release tag", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: [],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: false,
      reason: "untagged-commit",
    });
  });

  await t.test("refuses a clean tree with a tag for another version", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.0"],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: false,
      reason: "untagged-commit",
    });
  });

  await t.test("accepts no tag for an explicitly unreleased clean tree", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: [],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", true), {
      ok: true,
      tag: null,
    });
  });

  await t.test("refuses a dirty tree with the matching release tag", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: true,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: false,
      reason: "dirty-tree",
    });
  });

  await t.test("refuses a dirty tree in unreleased mode", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: true,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", true), {
      ok: false,
      reason: "dirty-tree",
    });
  });

  await t.test("names dirty-tree when a dirty tree is also untagged", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: true,
      tags: [],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: false,
      reason: "dirty-tree",
    });
  });

  await t.test("accepts the matching tag among several tags", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["nightly", "v27.8.1"],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: true,
      tag: "v27.8.1",
    });
  });

  await t.test("refuses several tags without the matching release tag", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.0", "nightly"],
    };

    assert.deepEqual(releaseVerdict(facts, "27.8.1", false), {
      ok: false,
      reason: "untagged-commit",
    });
  });

  await t.test("parses an output directory without a flag", () => {
    assert.deepEqual(parseArguments(["/out"]), {
      kind: "arguments",
      outputDirectory: "/out",
      unreleased: false,
    });
  });

  await t.test("parses the unreleased flag in either position", () => {
    assert.deepEqual(parseArguments(["--unreleased", "/out"]), {
      kind: "arguments",
      outputDirectory: "/out",
      unreleased: true,
    });
    assert.deepEqual(parseArguments(["/out", "--unreleased"]), {
      kind: "arguments",
      outputDirectory: "/out",
      unreleased: true,
    });
  });

  await t.test("parses usage without reading any release fact", () => {
    assert.deepEqual(parseArguments([]), { kind: "usage" });
    assert.deepEqual(parseArguments([""]), { kind: "usage" });
    assert.deepEqual(parseArguments(["--unreleased"]), { kind: "usage" });
    assert.deepEqual(parseArguments(["--tag", "/out"]), { kind: "usage" });
    assert.deepEqual(parseArguments(["/out", "/second"]), { kind: "usage" });
  });

  await t.test("chooses a released publish", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(cliDecision(["/out"], facts, "27.8.1"), {
      kind: "publish",
      outputDirectory: "/out",
      tag: "v27.8.1",
      notice: null,
    });
  });

  await t.test("chooses an unreleased publish with the flag first", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: [],
    };

    assert.deepEqual(cliDecision(["--unreleased", "/out"], facts, "27.8.1"), {
      kind: "publish",
      outputDirectory: "/out",
      tag: null,
      notice: "publishing an unreleased artifact",
    });
  });

  await t.test("chooses an unreleased publish with the flag last", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: [],
    };

    assert.deepEqual(cliDecision(["/out", "--unreleased"], facts, "27.8.1"), {
      kind: "publish",
      outputDirectory: "/out",
      tag: null,
      notice: "publishing an unreleased artifact",
    });
  });

  await t.test("refuses a dirty released publish", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: true,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(cliDecision(["/out"], facts, "27.8.1"), {
      kind: "refuse",
      reason: "dirty-tree",
    });
  });

  await t.test("refuses a dirty unreleased publish", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: true,
      tags: [],
    };

    assert.deepEqual(cliDecision(["--unreleased", "/out"], facts, "27.8.1"), {
      kind: "refuse",
      reason: "dirty-tree",
    });
  });

  await t.test("refuses an untagged released publish", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: [],
    };

    assert.deepEqual(cliDecision(["/out"], facts, "27.8.1"), {
      kind: "refuse",
      reason: "untagged-commit",
    });
  });

  await t.test("returns usage for no arguments", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(cliDecision([], facts, "27.8.1"), { kind: "usage" });
  });

  await t.test(
    "returns usage for an unreleased flag without a directory",
    () => {
      const facts: ReleaseFacts = {
        commit: "a".repeat(40),
        dirty: false,
        tags: [],
      };

      assert.deepEqual(cliDecision(["--unreleased"], facts, "27.8.1"), {
        kind: "usage",
      });
    },
  );

  await t.test("returns usage for an empty output directory", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(cliDecision([""], facts, "27.8.1"), { kind: "usage" });
  });

  await t.test("returns usage for an unknown flag", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(cliDecision(["--tag", "/out"], facts, "27.8.1"), {
      kind: "usage",
    });
  });

  await t.test("returns usage for two output directories", () => {
    const facts: ReleaseFacts = {
      commit: "a".repeat(40),
      dirty: false,
      tags: ["v27.8.1"],
    };

    assert.deepEqual(cliDecision(["/out", "/second"], facts, "27.8.1"), {
      kind: "usage",
    });
  });
});

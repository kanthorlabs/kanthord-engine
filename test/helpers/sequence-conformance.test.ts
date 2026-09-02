import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { assertConformance, recordSeams } from "./sequence-conformance.ts";

const story = resolve(
  import.meta.dirname,
  "../../.agents/plan/stories/050.1-the-claim/06-the-conformance-harness.md",
);

describe("test/helpers/sequence-conformance.test", () => {
  it("an unknown diagram id is refused", () => {
    assert.throws(
      () =>
        assertConformance({
          story,
          diagram: "missing-diagram",
          recorder: { tokens: [] },
          result: {},
        }),
      /unknown diagram id/,
    );
  });

  it("a participant outside the recorded dependency keys is refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `participant-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    participant Unknown",
        "    Client->>Command: node.claim",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ plan: { read: () => undefined } }, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "participant-check",
            recorder,
            result: {},
          }),
        /participant outside recorded dependency keys/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a dependency key colliding with a sequence end is refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `collision-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Caller",
        "    participant Command",
        "    Caller->>Command: expireRuns",
        "    Command-->>Caller: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ caller: { read: () => undefined } }, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "collision-check",
            recorder,
            result: {},
          }),
        /dependency key caller collides with the sequence end Caller/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a message that is not <n> <key>.<method> or <n> <key>.<method>:<label> is refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `message-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    participant Plan",
        "    Client->>Command: node.claim",
        "    Command-->Plan: malformed",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ plan: { read: () => undefined } }, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "message-check",
            recorder,
            result: {},
          }),
        /invalid message in diagram/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a non-dense ordinal sequence is refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `ordinal-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    participant Plan",
        "    Client->>Command: node.claim",
        "    Command->>Plan: 1 plan.read",
        "    Command->>Plan: 3 plan.write",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ plan: { read: () => undefined } }, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "ordinal-check",
            recorder,
            result: {},
          }),
        /non-dense ordinals in diagram/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("two steps carrying one token are refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `duplicate-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    participant Plan",
        "    Client->>Command: node.claim",
        "    Command->>Plan: 1 plan.read",
        "    Command->>Plan: 2 plan.read",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ plan: { read: () => undefined } }, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "duplicate-check",
            recorder: recorder,
            result: {},
          }),
        /duplicate token in diagram/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("two terminals are refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `terminal-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    Client->>Command: node.claim",
        "    Command-->>Client: ok",
        "    Command-->>Client: refuse:unroutable",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({}, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "terminal-check",
            recorder,
            result: {},
          }),
        /two terminals in diagram/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a diagram with neither a terminal nor an allowed note is refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `missing-terminal-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    Client->>Command: node.claim",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({}, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "missing-terminal-check",
            recorder,
            result: {},
          }),
        /no terminal or note/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a note over Command with an invalid tail pin is refused", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `invalid-note-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    Note over Command: tail pinned by EPIC 050.1",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({}, {});
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "invalid-note-check",
            recorder,
            result: {},
          }),
        /invalid Command note in diagram/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("diagrams containing `loop` or `opt` are refused by value", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `loop-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    loop retry",
        "        Command->>Command: 1 plan.read",
        "    end",
        "    Command-->>Client: ok",
        "```",
        "### `opt-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    opt optional",
        "        Command->>Command: 1 plan.read",
        "    end",
        "    Command-->>Command: ok",
        "```",
      ].join("\n"),
    );
    try {
      for (const diagram of ["loop-check", "opt-check"]) {
        assert.throws(
          () =>
            assertConformance({
              story: fixture,
              diagram,
              recorder: { tokens: [] },
              result: {},
            }),
          /uses loop or opt/,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a live diagram refuses function calls and occurrence discriminators", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `call-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    participant Plan",
        "    Client->>Command: node.claim",
        "    Command->>Plan: 1 plan.call",
        "    Command-->>Client: ok",
        "```",
        "### `discriminator-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Client",
        "    participant Command",
        "    participant Plan",
        "    Client->>Command: node.claim",
        "    Command->>Plan: 1 plan.read:#1",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ plan: { read: () => undefined } }, {});
      for (const diagram of ["call-check", "discriminator-check"]) {
        assert.throws(
          () =>
            assertConformance({
              story: fixture,
              diagram,
              recorder,
              result: {},
            }),
          /baseline-only discriminator in diagram/,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a recorded list with one extra step fails", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `extra-recorded-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    participant Plan",
        "    Command->>Plan: 1 plan.read",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams({ plan: { read: () => undefined } }, {});
      recorder.dependencies.plan.read();
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "extra-recorded-check",
            recorder: { tokens: [...recorder.tokens, "plan.write"] },
            result: {},
          }),
        /sequence mismatch for diagram extra-recorded-check/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a recorded list with one missing step fails", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `missing-recorded-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    participant Plan",
        "    Command->>Plan: 1 plan.read",
        "    Command->>Plan: 2 plan.write",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams(
        { plan: { read: () => undefined, write: () => undefined } },
        {},
      );
      recorder.dependencies.plan.read();
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "missing-recorded-check",
            recorder,
            result: {},
          }),
        /sequence mismatch for diagram missing-recorded-check/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("two adjacent steps swapped fail", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `swapped-recorded-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    participant Plan",
        "    Command->>Plan: 1 plan.read",
        "    Command->>Plan: 2 plan.write",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams(
        { plan: { read: () => undefined, write: () => undefined } },
        {},
      );
      recorder.dependencies.plan.write();
      recorder.dependencies.plan.read();
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "swapped-recorded-check",
            recorder,
            result: {},
          }),
        /sequence mismatch for diagram swapped-recorded-check/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("one differing label fails", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `differing-label-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    participant Plan",
        "    Command->>Plan: 1 plan.setNodeState:T:done",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams(
        {
          plan: {
            setNodeState: (input: Readonly<{ id: string; trigger: string }>) =>
              undefined,
          },
        },
        { task: "T" },
      );
      recorder.dependencies.plan.setNodeState({ id: "task", trigger: "done" });
      const recordedTokens = [...recorder.tokens];
      recordedTokens[0] = "plan.setNodeState:T:started";
      assert.throws(
        () =>
          assertConformance({
            story: fixture,
            diagram: "differing-label-check",
            recorder: { tokens: recordedTokens },
            result: {},
          }),
        /sequence mismatch for diagram differing-label-check/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("an exact list passes", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sequence-conformance-"));
    const fixture = resolve(directory, "story.md");
    writeFileSync(
      fixture,
      [
        "### `exact-recorded-check`",
        "```mermaid",
        "sequenceDiagram",
        "    participant Command",
        "    participant Plan",
        "    Command->>Plan: 1 plan.read",
        "    Command->>Plan: 2 plan.write",
        "    Command-->>Client: ok",
        "```",
      ].join("\n"),
    );
    try {
      const recorder = recordSeams(
        { plan: { read: () => undefined, write: () => undefined } },
        {},
      );
      recorder.dependencies.plan.read();
      recorder.dependencies.plan.write();
      assert.doesNotThrow(() =>
        assertConformance({
          story: fixture,
          diagram: "exact-recorded-check",
          recorder,
          result: {},
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a pure-domain call produces no token", () => {
    const recorder = recordSeams({ plan: { read: () => undefined } }, {});
    recorder.dependencies.plan.read();
    const beforePureCall = [...recorder.tokens];
    const pureDomainCall = (): string => "execution";

    assert.equal(pureDomainCall(), "execution");
    assert.deepEqual(recorder.tokens, beforePureCall);
  });

  it("a nested command bound to unrecorded dependencies is one token", () => {
    const unrecordedDependencies = { plan: { read: () => "nested-result" } };
    const nestedCommand = {
      run: () => unrecordedDependencies.plan.read(),
    };
    const recorder = recordSeams({ caller: nestedCommand }, {});

    assert.equal(recorder.dependencies.caller.run(), "nested-result");
    assert.deepEqual(recorder.tokens, ["caller.run"]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createShutdown } from "./shutdown.ts";

describe("src/http/server/shutdown.test", () => {
  it("runs every step in the declared order", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "a",
          run: () => {
            order.push("a");
          },
        },
        {
          name: "b",
          run: () => {
            order.push("b");
          },
        },
        {
          name: "c",
          run: () => {
            order.push("c");
          },
        },
      ],
      write: () => {},
      onSettled: () => {},
    });
    await shutdown();
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("writes exactly the stopped line and settles 0 when every step succeeds", async () => {
    const writes: string[] = [];
    const settled: number[] = [];
    const shutdown = createShutdown({
      steps: [{ name: "a", run: () => {} }],
      write: (text) => writes.push(text),
      onSettled: (code) => settled.push(code),
    });
    await shutdown();
    assert.deepEqual(writes, ["kanthord: stopped\n"]);
    assert.deepEqual(settled, [0]);
  });

  it("a failing middle step does not stop the sequence", async () => {
    const order: string[] = [];
    const writes: string[] = [];
    const settled: number[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "a",
          run: () => {
            order.push("a");
          },
        },
        {
          name: "b",
          run: () => {
            order.push("b");
            throw new Error("boom");
          },
        },
        {
          name: "c",
          run: () => {
            order.push("c");
          },
        },
      ],
      write: (text) => writes.push(text),
      onSettled: (code) => settled.push(code),
    });
    await shutdown();
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.ok(
      writes.some((line) => /^kanthord: shutdown: b failed: /.test(line)),
    );
    assert.deepEqual(settled, [1]);
    assert.equal(writes.includes("kanthord: stopped\n"), false);
  });

  it("two failing steps produce two failure lines and one settle at 1", async () => {
    const writes: string[] = [];
    const settled: number[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "a",
          run: () => {
            throw new Error("boom-a");
          },
        },
        {
          name: "b",
          run: () => {
            throw new Error("boom-b");
          },
        },
      ],
      write: (text) => writes.push(text),
      onSettled: (code) => settled.push(code),
    });
    await shutdown();
    const failureLines = writes.filter((line) =>
      line.startsWith("kanthord: shutdown: "),
    );
    assert.equal(failureLines.length, 2);
    assert.deepEqual(settled, [1]);
  });

  it("is idempotent across a second signal", async () => {
    let runs = 0;
    const settled: number[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "a",
          run: () => {
            runs += 1;
          },
        },
      ],
      write: () => {},
      onSettled: (code) => settled.push(code),
    });
    await shutdown();
    await shutdown();
    assert.equal(runs, 1);
    assert.deepEqual(settled, [0]);
  });

  it("is idempotent under concurrent calls", async () => {
    let runs = 0;
    const settled: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shutdown = createShutdown({
      steps: [
        {
          name: "a",
          run: () => {
            runs += 1;
            return gate;
          },
        },
      ],
      write: () => {},
      onSettled: (code) => settled.push(code),
    });
    const first = shutdown();
    const second = shutdown();
    release();
    await Promise.all([first, second]);
    assert.equal(runs, 1);
    assert.deepEqual(settled, [0]);
  });

  it("awaits an async step before the next one starts", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "a",
          run: async () => {
            order.push("a-start");
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            order.push("a-end");
          },
        },
        {
          name: "b",
          run: () => {
            order.push("b");
          },
        },
      ],
      write: () => {},
      onSettled: () => {},
    });
    await shutdown();
    assert.deepEqual(order, ["a-start", "a-end", "b"]);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createShutdown, createShutdownSteps } from "./shutdown.ts";
import type { ShutdownStep } from "./shutdown.ts";

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

  it("a cancel step declared first runs before the listener step", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "waits",
          run: () => {
            order.push("waits");
          },
        },
        {
          name: "listener",
          run: () => {
            order.push("listener");
          },
        },
        {
          name: "storage",
          run: () => {
            order.push("storage");
          },
        },
        {
          name: "home-lock",
          run: () => {
            order.push("home-lock");
          },
        },
      ],
      write: () => {},
      onSettled: () => {},
    });
    await shutdown();
    assert.deepEqual(order, ["waits", "listener", "storage", "home-lock"]);
  });

  it("a throwing cancel step does not stop the listener step", async () => {
    const order: string[] = [];
    const writes: string[] = [];
    const settled: number[] = [];
    const shutdown = createShutdown({
      steps: [
        {
          name: "waits",
          run: () => {
            order.push("waits");
            throw new Error("boom");
          },
        },
        {
          name: "listener",
          run: () => {
            order.push("listener");
          },
        },
        {
          name: "storage",
          run: () => {
            order.push("storage");
          },
        },
        {
          name: "home-lock",
          run: () => {
            order.push("home-lock");
          },
        },
      ],
      write: (text) => writes.push(text),
      onSettled: (code) => settled.push(code),
    });
    await shutdown();
    assert.deepEqual(order, ["waits", "listener", "storage", "home-lock"]);
    assert.deepEqual(settled, [1]);
    assert.equal(
      writes.filter((line) => /^kanthord: shutdown: waits failed: /.test(line))
        .length,
      1,
    );
  });

  it("the production steps run cancelWaits before listener close through the shared factory", async () => {
    const order: string[] = [];
    const steps = createShutdownSteps({
      cancelWaits: () => {
        order.push("cancelWaits");
      },
      listening: {
        close: () => {
          order.push("listener.close");
          return Promise.resolve();
        },
      },
      storage: {
        close: () => {
          order.push("storage.close");
        },
      },
      held: {
        release: () => {
          order.push("held.release");
        },
      },
    });
    assert.deepEqual(
      steps.map((step: ShutdownStep) => step.name),
      ["waits", "listener", "storage", "home-lock"],
    );

    const writes: string[] = [];
    let settledCode: number | undefined;
    const shutdown = createShutdown({
      steps,
      write: (text) => writes.push(text),
      onSettled: (code) => {
        settledCode = code;
      },
    });
    await shutdown();

    assert.deepEqual(order, [
      "cancelWaits",
      "listener.close",
      "storage.close",
      "held.release",
    ]);
    assert.equal(settledCode, 0);
    assert.deepEqual(writes, ["kanthord: stopped\n"]);
  });
});

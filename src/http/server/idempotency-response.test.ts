import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import {
  applyAnswer,
  captureAnswer,
  headerSnapshot,
} from "./idempotency-response.ts";
import type { StoredAnswer } from "./idempotency-response.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function buildCaptureApp(
  before: (context: import("koa").Context) => void,
  after: (context: import("koa").Context) => void,
): { app: Koa; captured: () => StoredAnswer | undefined } {
  let captured: StoredAnswer | undefined;
  const app = new Koa();
  app.use(async (context, next) => {
    before(context);
    const snapshot = headerSnapshot(context);
    await next();
    captured = captureAnswer(context, snapshot, context.status, context.body);
  });
  app.use((context) => {
    after(context);
  });
  return { app, captured: () => captured };
}

describe("src/http/server/idempotency-response.test", () => {
  describe("headerSnapshot and captureAnswer", () => {
    it("does not capture an untouched upstream header", async () => {
      const { app, captured } = buildCaptureApp(
        (context) => context.set("X-Before", "1"),
        (context) => {
          context.set("X-After", "2");
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.deepEqual(captured()!.headers, [
        ["content-type", ["application/json; charset=utf-8"]],
        ["x-after", ["2"]],
      ]);
      assert.ok(!captured()!.headers.some(([name]) => name === "x-before"));
    });

    it("captures a changed upstream header", async () => {
      const { app, captured } = buildCaptureApp(
        (context) => context.set("X-Before", "1"),
        (context) => {
          context.set("X-Before", "2");
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.ok(
        captured()!.headers.some(
          ([name, values]) =>
            name === "x-before" && values.length === 1 && values[0] === "2",
        ),
      );
    });

    it("captures a merged upstream header", async () => {
      const { app, captured } = buildCaptureApp(
        (context) => context.vary("Accept"),
        (context) => {
          context.vary("Origin");
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.ok(
        captured()!.headers.some(
          ([name, values]) =>
            name === "vary" &&
            values.length === 1 &&
            values[0] === "Accept, Origin",
        ),
      );
    });

    it("drops volatile header names", async () => {
      const { app, captured } = buildCaptureApp(
        () => {},
        (context) => {
          context.set("Content-Length", "99");
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.ok(
        !captured()!.headers.some(([name]) => name === "content-length"),
      );
    });

    it("orders captured headers bytewise by name", async () => {
      const { app, captured } = buildCaptureApp(
        () => {},
        (context) => {
          context.set("X-Zulu", "1");
          context.set("X-Alpha", "1");
          context.set("X-Mike", "1");
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.deepEqual(
        captured()!.headers.map(([name]) => name),
        ["content-type", "x-alpha", "x-mike", "x-zulu"],
      );
    });

    it("keeps every value of a repeated header", async () => {
      const { app, captured } = buildCaptureApp(
        () => {},
        (context) => {
          context.set("X-Multi", ["a", "b"]);
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.ok(
        captured()!.headers.some(
          ([name, values]) =>
            name === "x-multi" &&
            values.length === 2 &&
            values[0] === "a" &&
            values[1] === "b",
        ),
      );
    });

    it("renders a numeric header value as a string", async () => {
      const { app, captured } = buildCaptureApp(
        () => {},
        (context) => {
          context.set("X-Count", "7");
          context.body = { ok: true };
        },
      );
      await (await loopbackAgent(app)).get("/");
      assert.ok(
        captured()!.headers.some(
          ([name, values]) =>
            name === "x-count" && values.length === 1 && values[0] === "7",
        ),
      );
    });
  });

  describe("applyAnswer", () => {
    it("round-trips status, body and headers", async () => {
      const answer: StoredAnswer = {
        status: 201,
        body: { ok: true },
        headers: [
          ["etag", ['"abc"']],
          ["x-multi", ["a", "b"]],
        ],
      };
      const app = new Koa();
      app.use((context) => {
        applyAnswer(context, answer);
      });
      const response = await (await loopbackAgent(app)).get("/");
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, { ok: true });
      assert.equal(response.headers["etag"], '"abc"');
      assert.equal(response.headers["x-multi"], "a, b");
    });

    it("keeps the captured content type", async () => {
      const answer: StoredAnswer = {
        status: 200,
        body: { ok: true },
        headers: [["content-type", ["application/json; charset=utf-8"]]],
      };
      const app = new Koa();
      app.use((context) => {
        applyAnswer(context, answer);
      });
      const response = await (await loopbackAgent(app)).get("/");
      assert.match(
        String(response.headers["content-type"]),
        /application\/json; charset=utf-8/,
      );
    });

    it("keeps a 200 status even when the body is null", async () => {
      const answer: StoredAnswer = { status: 200, body: null, headers: [] };
      const app = new Koa();
      app.use((context) => {
        applyAnswer(context, answer);
      });
      const response = await (await loopbackAgent(app)).get("/");
      assert.equal(response.status, 200);
    });
  });
});

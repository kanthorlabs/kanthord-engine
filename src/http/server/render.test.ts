import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Context } from "hono";

import { HttpError } from "../contract/errors.ts";
import type { Operation } from "../contract/operation.ts";
import type { StoredAnswer } from "./idempotency-response.ts";
import { materializeResult, renderMiddleware } from "./render.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

describe("src/http/server/render.test", () => {
  const mediaOperation = (media?: string): Operation => ({
    operationId: "blob.show",
    method: "GET",
    path: [],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
    ...(media === undefined ? {} : { responseMedia: media }),
  });

  function emptyContext(): Context<AppEnv> {
    const context = new Context<AppEnv>(
      new Request("https://kanthord.invalid/v1/system/status"),
    );
    context.set("headers", new Headers());
    return context;
  }

  function stored(
    status: number,
    body: string | Uint8Array | null,
    contentType?: string,
  ): StoredAnswer {
    const headers: (readonly [string, string])[] = [];
    if (contentType !== undefined) {
      headers.push(["content-type", contentType]);
    }
    return { status, body, headers };
  }

  describe("materializeResult", () => {
    it("a json result serializes once to the exact string and sets the default content type", () => {
      const headers = new Headers();
      const materialized = materializeResult(
        { kind: "json", status: 200, body: { ok: true } },
        undefined,
        headers,
      );
      assert.deepEqual(materialized, {
        status: 200,
        body: '{"ok":true}',
      });
      assert.equal(
        headers.get("content-type"),
        "application/json; charset=utf-8",
      );
    });

    it("a bytes result keeps the exact Uint8Array object and sets the operation media type", () => {
      const headers = new Headers();
      const payload = new Uint8Array([1, 2, 3]);
      const materialized = materializeResult(
        { kind: "bytes", status: 200, bytes: payload },
        mediaOperation("application/xml"),
        headers,
      );
      assert.equal(materialized.status, 200);
      assert.strictEqual(materialized.body, payload);
      assert.equal(headers.get("content-type"), "application/xml");
    });

    it("an empty result keeps its status, stores no body and sets no content type", () => {
      for (const status of [204, 304] as const) {
        const headers = new Headers();
        const materialized = materializeResult(
          { kind: "empty", status },
          undefined,
          headers,
        );
        assert.deepEqual(materialized, { status, body: null });
        assert.equal(headers.get("content-type"), null);
      }
    });

    it("a seeded content type wins over the json default", () => {
      const headers = new Headers();
      headers.set("content-type", "text/csv");
      const materialized = materializeResult(
        { kind: "json", status: 200, body: { ok: true } },
        undefined,
        headers,
      );
      assert.deepEqual(materialized, {
        status: 200,
        body: '{"ok":true}',
      });
      assert.equal(headers.get("content-type"), "text/csv");
    });

    it("a seeded content type wins over the bytes default while the bytes stay identical", () => {
      const headers = new Headers();
      headers.set("content-type", "text/plain");
      const payload = new Uint8Array([9]);
      const materialized = materializeResult(
        { kind: "bytes", status: 200, bytes: payload },
        mediaOperation("image/png"),
        headers,
      );
      assert.strictEqual(materialized.body, payload);
      assert.equal(headers.get("content-type"), "text/plain");
    });

    it("a stateful toJSON value is serialized exactly once", () => {
      let calls = 0;
      const value = {
        toJSON: () => {
          calls += 1;
          return { n: 7 };
        },
      };
      const materialized = materializeResult(
        { kind: "json", status: 200, body: value },
        undefined,
        new Headers(),
      );
      assert.equal(calls, 1);
      assert.equal(materialized.body, '{"n":7}');
    });

    it("a json body that serializes to undefined raises the transport TypeError", () => {
      assert.throws(
        () =>
          materializeResult(
            { kind: "json", status: 200, body: undefined },
            undefined,
            new Headers(),
          ),
        (error: unknown) =>
          error instanceof TypeError &&
          error.message === "the handler result is not json serializable",
      );
    });

    it("a json body whose serialization throws propagates the original thrown object", () => {
      const thrown = new Error("boom");
      const poisoned = {
        toJSON: () => {
          throw thrown;
        },
      };
      try {
        materializeResult(
          { kind: "json", status: 200, body: poisoned },
          undefined,
          new Headers(),
        );
        assert.fail("expected a throw");
      } catch (error) {
        assert.strictEqual(error, thrown);
      }
    });

    it("a bytes result for an operation without responseMedia raises the internal-error refusal naming the operation id", () => {
      try {
        materializeResult(
          { kind: "bytes", status: 200, bytes: new Uint8Array([1]) },
          mediaOperation(undefined),
          new Headers(),
        );
        assert.fail("expected a throw");
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, "internal-error");
        assert.equal(
          error.message,
          "bytes result for blob.show requires responseMedia",
        );
      }
    });

    it("a bytes result without an operation raises the internal-error refusal", () => {
      try {
        materializeResult(
          { kind: "bytes", status: 200, bytes: new Uint8Array([1]) },
          undefined,
          new Headers(),
        );
        assert.fail("expected a throw");
      } catch (error) {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, "internal-error");
      }
    });
  });

  describe("renderMiddleware", () => {
    it("a json result answers the rendered response from the accumulator", async () => {
      const context = emptyContext();
      context.set("result", { kind: "json", status: 200, body: { ok: true } });
      const response = await renderMiddleware()(context, async () => {});
      assert.ok(response instanceof Response);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"ok":true}');
      assert.equal(
        demand(context, "headers").get("content-type"),
        "application/json; charset=utf-8",
      );
      assert.equal(
        response.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
    });

    it("a context that produced no result and no replay raises the internal-error refusal with the exact message", async () => {
      const context = emptyContext();
      await assert.rejects(
        renderMiddleware()(context, async () => {}),
        (error: unknown) =>
          error instanceof HttpError &&
          error.status === 500 &&
          error.message === "the transport produced no result",
      );
    });

    it("a context that carries c.error and a settled c.res is left alone", async () => {
      const context = emptyContext();
      const answer = new Response("error answer", { status: 500 });
      context.res = answer;
      context.error = new Error("downstream failed");
      context.set("result", { kind: "json", status: 200, body: { ok: true } });
      context.set("replay", stored(200, '{"x":1}'));
      const returned = await renderMiddleware()(context, async () => {});
      assert.equal(returned, undefined);
      assert.strictEqual(context.res, answer);
    });

    it("an empty 204 result on a context with no match answers 204 with an empty body, no content type and no throw", async () => {
      const context = emptyContext();
      context.set("result", { kind: "empty", status: 204 });
      const response = await renderMiddleware()(context, async () => {});
      assert.ok(response instanceof Response);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("content-type"), null);
    });

    it("a bytes result on a context with no match raises the internal-error refusal", async () => {
      const context = emptyContext();
      context.set("result", {
        kind: "bytes",
        status: 200,
        bytes: new Uint8Array([7]),
      });
      await assert.rejects(
        renderMiddleware()(context, async () => {}),
        (error: unknown) =>
          error instanceof HttpError && error.code === "internal-error",
      );
    });

    it("a replay of a stored json string answers the exact status, bytes and content type through set", async () => {
      const context = emptyContext();
      demand(context, "headers").set("content-type", "text/plain");
      context.set(
        "replay",
        stored(200, '{"x":1}', "application/json; charset=utf-8"),
      );
      const response = await renderMiddleware()(context, async () => {});
      assert.ok(response instanceof Response);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"x":1}');
      assert.equal(
        response.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
    });

    it("a replay of stored bytes answers the exact bytes", async () => {
      const context = emptyContext();
      const payload = new Uint8Array([1, 2, 3]);
      context.set("replay", stored(200, payload, "application/octet-stream"));
      const response = await renderMiddleware()(context, async () => {});
      assert.ok(response instanceof Response);
      assert.equal(response.status, 200);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
      assert.equal(
        response.headers.get("content-type"),
        "application/octet-stream",
      );
    });

    it("a replay of a stored null body answers an empty body", async () => {
      const context = emptyContext();
      context.set("replay", stored(204, null));
      const response = await renderMiddleware()(context, async () => {});
      assert.ok(response instanceof Response);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
    });
  });
});

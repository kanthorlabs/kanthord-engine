import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { captureAnswer, headerSnapshot } from "./idempotency-response.ts";
import type { StoredAnswer } from "./idempotency-response.ts";

type SeedPair = readonly [string, string];

function capturedAnswer(
  input: Readonly<{
    seed?: readonly SeedPair[];
    respond: (accumulator: Headers) => void;
    status: number;
    body: string | Uint8Array | null;
  }>,
): StoredAnswer {
  const accumulator = new Headers();
  for (const [name, value] of input.seed ?? []) {
    accumulator.set(name, value);
  }
  const before = headerSnapshot(accumulator);
  input.respond(accumulator);
  return captureAnswer(accumulator, before, input.status, input.body);
}

describe("src/http/server/idempotency-response.test", () => {
  describe("headerSnapshot", () => {
    it("lowers every name and joins duplicate values into one string", () => {
      const accumulator = new Headers();
      accumulator.set("X-Before", "1");
      accumulator.append("Vary", "Accept");
      accumulator.append("vary", "Origin");
      const snapshot = headerSnapshot(accumulator);
      assert.equal(snapshot.size, 2);
      assert.equal(snapshot.get("x-before"), "1");
      assert.equal(snapshot.get("vary"), "Accept, Origin");
    });
  });

  describe("captureAnswer", () => {
    it("does not capture an untouched upstream header", () => {
      const answer = capturedAnswer({
        seed: [["X-Before", "1"]],
        respond: (headers) => {
          headers.set("Content-Type", "application/json; charset=utf-8");
          headers.set("X-After", "2");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.deepEqual(answer.headers, [
        ["content-type", "application/json; charset=utf-8"],
        ["x-after", "2"],
      ]);
      assert.ok(!answer.headers.some(([name]) => name === "x-before"));
    });

    it("captures a changed upstream header as one joined value", () => {
      const answer = capturedAnswer({
        seed: [["X-Before", "1"]],
        respond: (headers) => {
          headers.set("X-Before", "2");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.ok(
        answer.headers.some(
          ([name, value]) => name === "x-before" && value === "2",
        ),
      );
    });

    it("captures a merged upstream vary as one joined value", () => {
      const answer = capturedAnswer({
        seed: [["Vary", "Accept"]],
        respond: (headers) => {
          headers.append("Vary", "Origin");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.deepEqual(answer.headers, [["vary", "Accept, Origin"]]);
    });

    it("drops volatile header names and captures the rest", () => {
      const answer = capturedAnswer({
        respond: (headers) => {
          headers.set("Content-Length", "99");
          headers.set("Content-Type", "application/json; charset=utf-8");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.deepEqual(answer.headers, [
        ["content-type", "application/json; charset=utf-8"],
      ]);
      assert.ok(!answer.headers.some(([name]) => name === "content-length"));
    });

    it("orders captured headers bytewise by lower-case name", () => {
      const answer = capturedAnswer({
        respond: (headers) => {
          headers.set("Content-Type", "application/json; charset=utf-8");
          headers.set("X-Zulu", "1");
          headers.set("X-Alpha", "1");
          headers.set("X-Mike", "1");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.deepEqual(
        answer.headers.map(([name]) => name),
        ["content-type", "x-alpha", "x-mike", "x-zulu"],
      );
    });

    it("stores one joined string for duplicate values, not an array", () => {
      const answer = capturedAnswer({
        respond: (headers) => {
          headers.append("X-Multi", "a");
          headers.append("X-Multi", "b");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.deepEqual(answer.headers, [["x-multi", "a, b"]]);
    });

    it("keeps the exact stored value of a numeric-looking header", () => {
      const answer = capturedAnswer({
        respond: (headers) => {
          headers.set("X-Count", "7");
        },
        status: 200,
        body: '{"ok":true}',
      });
      assert.ok(
        answer.headers.some(
          ([name, value]) => name === "x-count" && value === "7",
        ),
      );
    });

    it("status, the exact stored body and the content type survive capture", () => {
      const payload = Uint8Array.from([0x00, 0x80, 0xff]);
      const answer = capturedAnswer({
        respond: (headers) => {
          headers.set("Content-Type", "application/octet-stream");
        },
        status: 201,
        body: payload,
      });
      assert.equal(answer.status, 201);
      assert.strictEqual(answer.body, payload);
      assert.deepEqual(answer.headers, [
        ["content-type", "application/octet-stream"],
      ]);
    });
  });
});

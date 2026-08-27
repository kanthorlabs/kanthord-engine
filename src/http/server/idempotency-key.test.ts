import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";

import {
  IDEMPOTENCY_HEADER,
  MAX_KEY_LENGTH,
  fingerprint,
  readIdempotencyKey,
  recordKey,
} from "./idempotency-key.ts";
import { bodyMiddleware } from "./body.ts";
import { optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import type { Handler } from "./app.ts";
import type { Operation } from "../contract/operation.ts";
import { fetchAgent } from "../../../test/helpers/agent.ts";
import {
  HARNESS_ACTOR_FIXTURE,
  HARNESS_ACTOR_FIXTURE_B,
} from "../../../test/helpers/app.ts";

describe("src/http/server/idempotency-key.test", () => {
  it("exports the header name and the max key length", () => {
    assert.equal(IDEMPOTENCY_HEADER, "idempotency-key");
    assert.equal(MAX_KEY_LENGTH, 255);
  });

  describe("readIdempotencyKey", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly headers: readonly (readonly [string, string])[];
      readonly expect: ReturnType<typeof readIdempotencyKey>;
    }> = [
      { name: "no headers", headers: [], expect: { kind: "absent" } },
      {
        name: "unrelated header",
        headers: [["Host", "a.test"]],
        expect: { kind: "absent" },
      },
      {
        name: "canonical case",
        headers: [["Idempotency-Key", "abc"]],
        expect: { kind: "ok", key: "abc" },
      },
      {
        name: "lower case",
        headers: [["idempotency-key", "abc"]],
        expect: { kind: "ok", key: "abc" },
      },
      {
        name: "upper case",
        headers: [["IDEMPOTENCY-KEY", "abc"]],
        expect: { kind: "ok", key: "abc" },
      },
      {
        name: "repeated header, same case",
        headers: [
          ["Idempotency-Key", "a"],
          ["Idempotency-Key", "b"],
        ],
        expect: {
          kind: "invalid",
          message: "Idempotency-Key was supplied more than once",
        },
      },
      {
        name: "repeated header, different case, same value",
        headers: [
          ["Idempotency-Key", "a"],
          ["idempotency-key", "a"],
        ],
        expect: {
          kind: "invalid",
          message: "Idempotency-Key was supplied more than once",
        },
      },
      {
        name: "empty value",
        headers: [["Idempotency-Key", ""]],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "interior space is legal",
        headers: [["Idempotency-Key", "a b"]],
        expect: { kind: "ok", key: "a b" },
      },
      {
        name: "free-form importId with a space",
        headers: [["Idempotency-Key", "release candidate"]],
        expect: { kind: "ok", key: "release candidate" },
      },
      {
        name: "leading space reaches the reader trimmed to a valid key",
        headers: [["Idempotency-Key", " ab"]],
        expect: { kind: "ok", key: "ab" },
      },
      {
        name: "trailing space reaches the reader trimmed to a valid key",
        headers: [["Idempotency-Key", "ab "]],
        expect: { kind: "ok", key: "ab" },
      },
      {
        name: "a single space trims to an empty value",
        headers: [["Idempotency-Key", " "]],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "interior tab character",
        headers: [["Idempotency-Key", "a\tb"]],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "non-ASCII character",
        headers: [["Idempotency-Key", "café"]],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "single character",
        headers: [["Idempotency-Key", "a"]],
        expect: { kind: "ok", key: "a" },
      },
      {
        name: "255 characters",
        headers: [["Idempotency-Key", "a".repeat(255)]],
        expect: { kind: "ok", key: "a".repeat(255) },
      },
      {
        name: "256 characters",
        headers: [["Idempotency-Key", "a".repeat(256)]],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "a ULID",
        headers: [["Idempotency-Key", "01JQ8Z7G3H4K5M6N7P8Q9R0S1T"]],
        expect: { kind: "ok", key: "01JQ8Z7G3H4K5M6N7P8Q9R0S1T" },
      },
      {
        name: "a comma inside the value means the key was supplied more than once",
        headers: [["Idempotency-Key", "a,b"]],
        expect: {
          kind: "invalid",
          message: "Idempotency-Key was supplied more than once",
        },
      },
      {
        name: "the narrowest legal single characters",
        headers: [["Idempotency-Key", "!~"]],
        expect: { kind: "ok", key: "!~" },
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        const accumulator = new Headers();
        for (const [name, value] of testCase.headers) {
          accumulator.append(name, value);
        }
        assert.deepEqual(readIdempotencyKey(accumulator), testCase.expect);
      });
    }

    it("reads the joined duplicate value the way the transport delivers it", () => {
      const accumulator = new Headers();
      accumulator.append("Idempotency-Key", "a");
      accumulator.append("idempotency-key", "b");
      assert.deepEqual(readIdempotencyKey(accumulator), {
        kind: "invalid",
        message: "Idempotency-Key was supplied more than once",
      });
    });
  });

  describe("fingerprint", () => {
    it("returns 64 lowercase hex characters", async () => {
      const result = await fingerprint({
        method: "POST",
        path: "/v1/project",
        query: "",
        rawBody: "{}",
      });
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    it("is deterministic for identical input", async () => {
      const input = {
        method: "POST",
        path: "/v1/project",
        query: "",
        rawBody: "{}",
      };
      assert.equal(await fingerprint(input), await fingerprint(input));
    });

    it("changes with a different raw body", async () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      assert.notEqual(
        await fingerprint({ ...base, rawBody: '{"a":1}' }),
        await fingerprint({ ...base, rawBody: '{"a":2}' }),
      );
    });

    it("treats whitespace as significant (raw-byte property)", async () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      assert.notEqual(
        await fingerprint({ ...base, rawBody: '{"a":1}' }),
        await fingerprint({ ...base, rawBody: '{ "a": 1 }' }),
      );
    });

    it("treats key order as significant", async () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      assert.notEqual(
        await fingerprint({ ...base, rawBody: '{"a":1,"b":2}' }),
        await fingerprint({ ...base, rawBody: '{"b":2,"a":1}' }),
      );
    });

    it("changes with a different query string", async () => {
      const base = { method: "POST", path: "/v1/project", rawBody: "{}" };
      assert.notEqual(
        await fingerprint({ ...base, query: "" }),
        await fingerprint({ ...base, query: "force=1" }),
      );
    });

    it("changes with a different path", async () => {
      const base = { method: "POST", query: "", rawBody: "{}" };
      assert.notEqual(
        await fingerprint({ ...base, path: "/v1/project" }),
        await fingerprint({ ...base, path: "/v1/project/p_1" }),
      );
    });

    it("changes with a different method", async () => {
      const base = { path: "/v1/project", query: "", rawBody: "{}" };
      assert.notEqual(
        await fingerprint({ ...base, method: "POST" }),
        await fingerprint({ ...base, method: "PUT" }),
      );
    });

    it("non-ASCII bytes survive the length prefix", async () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      const withAccent = await fingerprint({ ...base, rawBody: '{"n":"é"}' });
      const withoutAccent = await fingerprint({
        ...base,
        rawBody: '{"n":"e"}',
      });
      assert.notEqual(withAccent, withoutAccent);
      assert.match(withAccent, /^[0-9a-f]{64}$/);
      assert.match(withoutAccent, /^[0-9a-f]{64}$/);
    });

    it("the length prefix prevents repartitioning across fields", async () => {
      assert.notEqual(
        await fingerprint({ method: "AB", path: "C", query: "", rawBody: "" }),
        await fingerprint({ method: "A", path: "BC", query: "", rawBody: "" }),
      );
    });

    it("pins the fingerprint for a known input", async () => {
      const result = await fingerprint({
        method: "POST",
        path: "/v1/project",
        query: "",
        rawBody: '{"name":"alpha"}',
      });
      assert.equal(
        result,
        "66b93b3eabfa98df5795caabe974cdea65919a17be5586c784d59570c2e435e3",
      );
    });
  });

  describe("recordKey", () => {
    it("renders with no parameters", () => {
      assert.equal(
        recordKey({
          operationId: "project.create",
          parameters: {},
          actorId: "actor_A",
          key: "k",
        }),
        "project.create\uFFFD\uFFFDactor_A\uFFFDk",
      );
    });

    it("renders with one parameter", () => {
      assert.equal(
        recordKey({
          operationId: "plan.validate",
          parameters: { id: "p_1" },
          actorId: "actor_A",
          key: "k",
        }),
        "plan.validate\uFFFDid=p_1\uFFFDactor_A\uFFFDk",
      );
    });

    it("differs across operations for the same key", () => {
      assert.notEqual(
        recordKey({
          operationId: "a",
          parameters: {},
          actorId: "actor_A",
          key: "k",
        }),
        recordKey({
          operationId: "b",
          parameters: {},
          actorId: "actor_A",
          key: "k",
        }),
      );
    });

    it("differs across resources for the same operation and key", () => {
      assert.notEqual(
        recordKey({
          operationId: "x",
          parameters: { id: "p_1" },
          actorId: "actor_A",
          key: "k",
        }),
        recordKey({
          operationId: "x",
          parameters: { id: "p_2" },
          actorId: "actor_A",
          key: "k",
        }),
      );
    });

    it("sorts parameters bytewise regardless of input order", () => {
      const first = recordKey({
        operationId: "x",
        parameters: { id: "1", hash: "2" },
        actorId: "actor_A",
        key: "k",
      });
      const second = recordKey({
        operationId: "x",
        parameters: { hash: "2", id: "1" },
        actorId: "actor_A",
        key: "k",
      });
      assert.equal(first, second);
      assert.equal(first, "x\uFFFDhash=2\u0001id=1\uFFFDactor_A\uFFFDk");
    });

    it("two actors whose ids differ by one character render different keys", () => {
      const first = recordKey({
        operationId: "project.create",
        parameters: {},
        actorId: HARNESS_ACTOR_FIXTURE.id,
        key: "k",
      });
      const second = recordKey({
        operationId: "project.create",
        parameters: {},
        actorId: HARNESS_ACTOR_FIXTURE_B.id,
        key: "k",
      });
      assert.notEqual(first, second);
    });

    it("a key value containing the separator cannot forge a boundary", () => {
      const forged = recordKey({
        operationId: "project.create",
        parameters: {},
        actorId: "actor_A",
        key: "\uFFFDactor_B\uFFFDx",
      });
      const genuine = recordKey({
        operationId: "project.create",
        parameters: {},
        actorId: "actor_B",
        key: "x",
      });
      assert.notEqual(forged, genuine);
    });

    it("a parameter value containing the separator cannot collide with a different actor id", () => {
      const forged = recordKey({
        operationId: "project.create",
        parameters: { id: "\uFFFDactor_B\uFFFDx" },
        actorId: "actor_A",
        key: "k",
      });
      const genuine = recordKey({
        operationId: "project.create",
        parameters: {},
        actorId: "actor_B",
        key: "k",
      });
      assert.notEqual(forged, genuine);
    });

    it("the same actor and the same key render the identical string across two calls", () => {
      const input = {
        operationId: "project.create",
        parameters: {},
        actorId: "actor_A",
        key: "k",
      };
      assert.equal(recordKey(input), recordKey(input));
    });

    it("sorts parameter names bytewise with non-ASCII names", () => {
      const first = recordKey({
        operationId: "x",
        parameters: { "\u{1F600}": "2", "\uE000": "1" },
        actorId: "actor_A",
        key: "k",
      });
      const second = recordKey({
        operationId: "x",
        parameters: { "\uE000": "1", "\u{1F600}": "2" },
        actorId: "actor_A",
        key: "k",
      });
      assert.equal(first, second);
      assert.equal(
        first,
        "x\uFFFD\uE000=1\u0001\u{1F600}=2\uFFFDactor_A\uFFFDk",
      );
    });
  });

  describe("raw body preservation (body middleware probe)", () => {
    function probeApp(): Hono<AppEnv> {
      const operation: Operation = {
        operationId: "node.create",
        method: "POST",
        path: [],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human", "harness"],
      };
      const handlers: Readonly<Record<string, Handler>> = {
        "node.create": () => ({ kind: "json", status: 200, body: {} }),
      };
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("match", { operation, parameters: {} });
        await next();
      });
      app.use("*", bodyMiddleware(handlers));
      app.all("*", (c) => {
        return c.json({ raw: optional(c, "rawBody") ?? null });
      });
      return app;
    }

    it("preserves the exact request bytes for a json body", async () => {
      const app = probeApp();
      const agent = fetchAgent(app);
      const response = await agent
        .post("/")
        .set("Content-Type", "application/json")
        .send('{ "a" : 1 }');
      assert.equal(response.body.raw, '{ "a" : 1 }');
    });

    it("is null when the content type is not json", async () => {
      const app = probeApp();
      const agent = fetchAgent(app);
      const response = await agent
        .post("/")
        .set("Content-Type", "text/plain")
        .send("hello");
      assert.equal(response.body.raw, null);
    });

    it("is null for a GET with no body", async () => {
      const app = probeApp();
      const agent = fetchAgent(app);
      const response = await agent.get("/");
      assert.equal(response.body.raw, null);
    });
  });
});

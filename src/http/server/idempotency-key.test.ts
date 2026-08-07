import { describe, it } from "node:test";
import assert from "node:assert/strict";

import bodyParser from "@koa/bodyparser";
import Koa from "koa";

import {
  IDEMPOTENCY_HEADER,
  MAX_KEY_LENGTH,
  fingerprint,
  readIdempotencyKey,
  recordKey,
} from "./idempotency-key.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

describe("src/http/server/idempotency-key.test", () => {
  it("exports the header name and the max key length", () => {
    assert.equal(IDEMPOTENCY_HEADER, "idempotency-key");
    assert.equal(MAX_KEY_LENGTH, 255);
  });

  describe("readIdempotencyKey", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly rawHeaders: readonly string[];
      readonly expect: ReturnType<typeof readIdempotencyKey>;
    }> = [
      { name: "no headers", rawHeaders: [], expect: { kind: "absent" } },
      {
        name: "unrelated header",
        rawHeaders: ["Host", "a.test"],
        expect: { kind: "absent" },
      },
      {
        name: "canonical case",
        rawHeaders: ["Idempotency-Key", "abc"],
        expect: { kind: "ok", key: "abc" },
      },
      {
        name: "lower case",
        rawHeaders: ["idempotency-key", "abc"],
        expect: { kind: "ok", key: "abc" },
      },
      {
        name: "upper case",
        rawHeaders: ["IDEMPOTENCY-KEY", "abc"],
        expect: { kind: "ok", key: "abc" },
      },
      {
        name: "repeated header, same case",
        rawHeaders: ["Idempotency-Key", "a", "Idempotency-Key", "b"],
        expect: {
          kind: "invalid",
          message: "Idempotency-Key was supplied more than once",
        },
      },
      {
        name: "repeated header, different case, same value",
        rawHeaders: ["Idempotency-Key", "a", "idempotency-key", "a"],
        expect: {
          kind: "invalid",
          message: "Idempotency-Key was supplied more than once",
        },
      },
      {
        name: "empty value",
        rawHeaders: ["Idempotency-Key", ""],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "interior space is legal",
        rawHeaders: ["Idempotency-Key", "a b"],
        expect: { kind: "ok", key: "a b" },
      },
      {
        name: "free-form importId with a space",
        rawHeaders: ["Idempotency-Key", "release candidate"],
        expect: { kind: "ok", key: "release candidate" },
      },
      {
        name: "leading space",
        rawHeaders: ["Idempotency-Key", " ab"],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "trailing space",
        rawHeaders: ["Idempotency-Key", "ab "],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "a single space",
        rawHeaders: ["Idempotency-Key", " "],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "tab character",
        rawHeaders: ["Idempotency-Key", "a\tb"],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "non-ASCII character",
        rawHeaders: ["Idempotency-Key", "café"],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "single character",
        rawHeaders: ["Idempotency-Key", "a"],
        expect: { kind: "ok", key: "a" },
      },
      {
        name: "255 characters",
        rawHeaders: ["Idempotency-Key", "a".repeat(255)],
        expect: { kind: "ok", key: "a".repeat(255) },
      },
      {
        name: "256 characters",
        rawHeaders: ["Idempotency-Key", "a".repeat(256)],
        expect: {
          kind: "invalid",
          message:
            "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
        },
      },
      {
        name: "a ULID",
        rawHeaders: ["Idempotency-Key", "01JQ8Z7G3H4K5M6N7P8Q9R0S1T"],
        expect: { kind: "ok", key: "01JQ8Z7G3H4K5M6N7P8Q9R0S1T" },
      },
      {
        name: "a comma inside the value",
        rawHeaders: ["Idempotency-Key", "a,b"],
        expect: { kind: "ok", key: "a,b" },
      },
      {
        name: "the narrowest legal single characters",
        rawHeaders: ["Idempotency-Key", "!~"],
        expect: { kind: "ok", key: "!~" },
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        assert.deepEqual(
          readIdempotencyKey({ rawHeaders: testCase.rawHeaders }),
          testCase.expect,
        );
      });
    }
  });

  describe("fingerprint", () => {
    it("returns 64 lowercase hex characters", () => {
      const result = fingerprint({
        method: "POST",
        path: "/v1/project",
        query: "",
        rawBody: "{}",
      });
      assert.match(result, /^[0-9a-f]{64}$/);
    });

    it("is deterministic for identical input", () => {
      const input = {
        method: "POST",
        path: "/v1/project",
        query: "",
        rawBody: "{}",
      };
      assert.equal(fingerprint(input), fingerprint(input));
    });

    it("changes with a different raw body", () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      assert.notEqual(
        fingerprint({ ...base, rawBody: '{"a":1}' }),
        fingerprint({ ...base, rawBody: '{"a":2}' }),
      );
    });

    it("treats whitespace as significant (raw-byte property)", () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      assert.notEqual(
        fingerprint({ ...base, rawBody: '{"a":1}' }),
        fingerprint({ ...base, rawBody: '{ "a": 1 }' }),
      );
    });

    it("treats key order as significant", () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      assert.notEqual(
        fingerprint({ ...base, rawBody: '{"a":1,"b":2}' }),
        fingerprint({ ...base, rawBody: '{"b":2,"a":1}' }),
      );
    });

    it("changes with a different query string", () => {
      const base = { method: "POST", path: "/v1/project", rawBody: "{}" };
      assert.notEqual(
        fingerprint({ ...base, query: "" }),
        fingerprint({ ...base, query: "force=1" }),
      );
    });

    it("changes with a different path", () => {
      const base = { method: "POST", query: "", rawBody: "{}" };
      assert.notEqual(
        fingerprint({ ...base, path: "/v1/project" }),
        fingerprint({ ...base, path: "/v1/project/p_1" }),
      );
    });

    it("changes with a different method", () => {
      const base = { path: "/v1/project", query: "", rawBody: "{}" };
      assert.notEqual(
        fingerprint({ ...base, method: "POST" }),
        fingerprint({ ...base, method: "PUT" }),
      );
    });

    it("non-ASCII bytes survive the length prefix", () => {
      const base = { method: "POST", path: "/v1/project", query: "" };
      const withAccent = fingerprint({ ...base, rawBody: '{"n":"é"}' });
      const withoutAccent = fingerprint({ ...base, rawBody: '{"n":"e"}' });
      assert.notEqual(withAccent, withoutAccent);
      assert.match(withAccent, /^[0-9a-f]{64}$/);
      assert.match(withoutAccent, /^[0-9a-f]{64}$/);
    });

    it("the length prefix prevents repartitioning across fields", () => {
      assert.notEqual(
        fingerprint({ method: "AB", path: "C", query: "", rawBody: "" }),
        fingerprint({ method: "A", path: "BC", query: "", rawBody: "" }),
      );
    });
  });

  describe("recordKey", () => {
    it("renders with no parameters", () => {
      assert.equal(
        recordKey({ operationId: "project.create", parameters: {}, key: "k" }),
        "project.create��k",
      );
    });

    it("renders with one parameter", () => {
      assert.equal(
        recordKey({
          operationId: "plan.validate",
          parameters: { id: "p_1" },
          key: "k",
        }),
        "plan.validate�id=p_1�k",
      );
    });

    it("differs across operations for the same key", () => {
      assert.notEqual(
        recordKey({ operationId: "a", parameters: {}, key: "k" }),
        recordKey({ operationId: "b", parameters: {}, key: "k" }),
      );
    });

    it("differs across resources for the same operation and key", () => {
      assert.notEqual(
        recordKey({
          operationId: "x",
          parameters: { id: "p_1" },
          key: "k",
        }),
        recordKey({
          operationId: "x",
          parameters: { id: "p_2" },
          key: "k",
        }),
      );
    });

    it("sorts parameters bytewise regardless of input order", () => {
      const first = recordKey({
        operationId: "x",
        parameters: { id: "1", hash: "2" },
        key: "k",
      });
      const second = recordKey({
        operationId: "x",
        parameters: { hash: "2", id: "1" },
        key: "k",
      });
      assert.equal(first, second);
      assert.equal(first, "x�hash=2id=1�k");
    });
  });

  describe("raw body preservation (vendor probe)", () => {
    function probeApp(): Koa {
      const app = new Koa();
      app.use(bodyParser({ enableTypes: ["json"] }));
      app.use((context) => {
        context.body = { raw: context.request.rawBody ?? null };
      });
      return app;
    }

    it("preserves the exact request bytes for a json body", async () => {
      const app = probeApp();
      const agent = await loopbackAgent(app);
      const response = await agent
        .post("/")
        .set("Content-Type", "application/json")
        .send('{ "a" : 1 }');
      assert.equal(response.body.raw, '{ "a" : 1 }');
    });

    it("is null when the content type is not json", async () => {
      const app = probeApp();
      const agent = await loopbackAgent(app);
      const response = await agent
        .post("/")
        .set("Content-Type", "text/plain")
        .send("hello");
      assert.equal(response.body.raw, null);
    });

    it("is null for a GET with no body", async () => {
      const app = probeApp();
      const agent = await loopbackAgent(app);
      const response = await agent.get("/");
      assert.equal(response.body.raw, null);
    });
  });
});

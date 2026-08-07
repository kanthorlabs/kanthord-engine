import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa, { type Middleware } from "koa";

import { envelopeMiddleware } from "./envelope.ts";
import { originMiddleware } from "./origin.ts";
import { httpError } from "../contract/errors.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function buildApp(
  middleware: Middleware,
  downstream?: (context: import("koa").Context) => void,
): Koa {
  const app = new Koa();
  app.use(envelopeMiddleware({ onInternalError: () => {} }));
  app.use(middleware);
  app.use((context) => {
    if (downstream) {
      downstream(context);
      return;
    }
    context.body = { reached: true };
  });
  return app;
}

function refusedBody(origin: string) {
  return {
    error: {
      code: "origin-forbidden",
      message: `the Origin header ${origin} is outside the allow list`,
    },
  };
}

describe("src/http/server/origin.test", () => {
  describe("empty allow list", () => {
    it("no Origin header passes through untouched", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins: [] }));
      const response = await (await loopbackAgent(app)).get("/");
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { reached: true });
      assert.equal(response.headers["access-control-allow-origin"], undefined);
      assert.equal(response.headers["vary"], undefined);
    });

    it("refuses every Origin value in the table with the same 403 shape", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins: [] }));
      const values = [
        "http://evil.example",
        "null",
        "",
        "http://127.0.0.1",
        "http://localhost:7421",
        "https://kanthord.test",
      ];
      for (const value of values) {
        const response = await (
          await loopbackAgent(app)
        )
          .get("/")
          .set("Origin", value);
        assert.equal(response.status, 403, `Origin ${JSON.stringify(value)}`);
        assert.deepEqual(
          response.body,
          refusedBody(value),
          `Origin ${JSON.stringify(value)}`,
        );
        assert.equal(
          response.headers["access-control-allow-origin"],
          undefined,
          `Origin ${JSON.stringify(value)}`,
        );
      }
    });

    it("a Referer header alone does not trigger the check", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins: [] }));
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Referer", "http://evil.example");
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { reached: true });
    });

    it("refuses a disallowed Origin on every method", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins: [] }));
      for (const method of ["get", "post", "put", "delete"] as const) {
        const response = await (
          await loopbackAgent(app)
        )
          [method]("/")
          .set("Origin", "http://evil.example");
        assert.equal(response.status, 403, method);
        assert.deepEqual(
          response.body,
          refusedBody("http://evil.example"),
          method,
        );
      }
    });
  });

  describe('allow list ["http://localhost:8080"]', () => {
    const allowedOrigins = ["http://localhost:8080"];

    it("the exact allowed origin passes with the header and Vary set", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(response.status, 200);
      assert.equal(
        response.headers["access-control-allow-origin"],
        "http://localhost:8080",
      );
      assert.equal(response.headers["vary"], "Origin");
    });

    it("refuses everything outside the exact origin", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const values = [
        "http://localhost:8081",
        "https://localhost:8080",
        "http://localhost.evil.test:8080",
        "http://evil.test",
        "null",
      ];
      for (const value of values) {
        const response = await (
          await loopbackAgent(app)
        )
          .get("/")
          .set("Origin", value);
        assert.equal(response.status, 403, value);
        assert.deepEqual(response.body, refusedBody(value), value);
        assert.equal(
          response.headers["access-control-allow-origin"],
          undefined,
          value,
        );
      }
    });
  });

  describe('allow list ["http://localhost"]', () => {
    it("matches a received http://localhost, proving default-port and case canonicalization on load", async () => {
      const app = buildApp(
        originMiddleware({ allowedOrigins: ["http://localhost"] }),
      );
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost");
      assert.equal(response.status, 200);
      assert.equal(
        response.headers["access-control-allow-origin"],
        "http://localhost",
      );
    });
  });

  describe("Vary merging and error survival", () => {
    it("appends Origin to an existing Vary value set downstream", async () => {
      const app = buildApp(
        originMiddleware({ allowedOrigins: ["http://localhost:8080"] }),
        (context) => {
          context.vary("Accept");
          context.body = { reached: true };
        },
      );
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(response.status, 200);
      assert.equal(response.headers["vary"], "Accept, Origin");
    });

    it("a downstream throw still carries Vary and Access-Control-Allow-Origin", async () => {
      const app = buildApp(
        originMiddleware({ allowedOrigins: ["http://localhost:8080"] }),
        () => {
          throw httpError("not-found", "nope");
        },
      );
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(response.status, 404);
      assert.equal(
        response.headers["access-control-allow-origin"],
        "http://localhost:8080",
      );
      assert.ok(response.headers["vary"]?.includes("Origin"));
    });

    it("Access-Control-Allow-Credentials is absent on every response, allowed and refused alike", async () => {
      const app = buildApp(
        originMiddleware({ allowedOrigins: ["http://localhost:8080"] }),
      );
      const allowed = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(
        allowed.headers["access-control-allow-credentials"],
        undefined,
      );
      const refused = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://evil.example");
      assert.equal(
        refused.headers["access-control-allow-credentials"],
        undefined,
      );
    });
  });

  describe("Access-Control-Expose-Headers", () => {
    const allowedOrigins = ["http://localhost:8080"];
    const expected = "etag, accept-ranges, content-range";

    it("a GET from the allowed origin carries the exact expose-headers value", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(response.status, 200);
      assert.equal(response.headers["access-control-expose-headers"], expected);
    });

    it("post, put and delete from the allowed origin carry the same exact value", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      for (const method of ["post", "put", "delete"] as const) {
        const response = await (
          await loopbackAgent(app)
        )
          [method]("/")
          .set("Origin", "http://localhost:8080");
        assert.equal(
          response.headers["access-control-expose-headers"],
          expected,
          method,
        );
      }
    });

    it("an OPTIONS from the allowed origin carries no expose-headers value", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const response = await (
        await loopbackAgent(app)
      )
        .options("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(
        response.headers["access-control-expose-headers"],
        undefined,
      );
    });

    it("no Origin header means no expose-headers value", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const response = await (await loopbackAgent(app)).get("/");
      assert.equal(
        response.headers["access-control-expose-headers"],
        undefined,
      );
    });

    it("a refused Origin carries no expose-headers value", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://evil.test");
      assert.equal(response.status, 403);
      assert.equal(
        response.headers["access-control-expose-headers"],
        undefined,
      );
    });

    it("a downstream throw still carries the exact expose-headers value", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }), () => {
        throw httpError("not-found", "nope");
      });
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(response.status, 404);
      assert.equal(response.headers["access-control-expose-headers"], expected);
    });

    it("Access-Control-Allow-Credentials stays absent on every response above", async () => {
      const app = buildApp(originMiddleware({ allowedOrigins }));
      const allowed = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", "http://localhost:8080");
      assert.equal(
        allowed.headers["access-control-allow-credentials"],
        undefined,
      );
    });
  });
});

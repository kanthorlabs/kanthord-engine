import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import { envelopeMiddleware } from "./envelope.ts";
import { authMiddleware, bearerToken, tokensMatch } from "./auth.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function buildApp(token: string): Koa {
  const app = new Koa();
  app.use(envelopeMiddleware({ onInternalError: () => {} }));
  app.use(authMiddleware({ token }));
  app.use((context) => {
    context.body = { reached: true };
  });
  return app;
}

function sourceText(): string {
  return readFileSync(resolve(import.meta.dirname, "./auth.ts"), "utf8");
}

describe("src/http/server/auth.test", () => {
  it("matches an identical token and rejects a different one", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
    assert.equal(tokensMatch("abc", "abd"), false);
  });

  it("rejects a wrong-length token without throwing", () => {
    assert.equal(tokensMatch("abc", "abcd"), false);
  });

  it("treats two empty strings as equal and an empty presented token as wrong", () => {
    assert.equal(tokensMatch("", ""), true);
    assert.equal(tokensMatch("abc", ""), false);
  });

  it("compares the token case-sensitively", () => {
    assert.equal(tokensMatch("Abc", "abc"), false);
  });

  it("parses the bearer scheme case-insensitively and rejects everything else", () => {
    const cases: ReadonlyArray<readonly [string | undefined, string | null]> = [
      [undefined, null],
      ["", null],
      ["abc", null],
      ["Bearer", null],
      ["Bearer ", null],
      ["Bearer abc", "abc"],
      ["bearer abc", "abc"],
      ["BEARER abc", "abc"],
      ["Basic abc", null],
      ["Bearer abc def", "abc def"],
    ];
    for (const [header, expected] of cases) {
      assert.equal(bearerToken(header), expected, JSON.stringify(header));
    }
  });

  it("compares in constant time by construction", () => {
    const source = sourceText();
    assert.equal(source.includes("timingSafeEqual("), true);
    assert.equal(source.includes('createHash("sha256")'), true);
  });

  it("never compares the tokens with an operator or a length-leaking primitive", () => {
    const source = sourceText();
    assert.equal(/configured\s*[=!]==?\s*presented/.test(source), false);
    assert.equal(/presented\s*[=!]==?\s*configured/.test(source), false);
    assert.equal(source.includes("Buffer.compare"), false);
    assert.equal(source.includes("localeCompare"), false);
  });

  it("stays route-independent by construction", () => {
    const source = sourceText();
    assert.equal(source.includes("context.state"), false);
    assert.equal(source.includes("registry"), false);
    assert.equal(source.includes("operationId"), false);
  });

  it("answers 401 unauthenticated when no token is presented", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    ).get("/v1/health");
    assert.equal(response.body.reached, undefined);
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: { code: "unauthenticated", message: "no bearer token" },
    });
  });

  it("answers 401 with the not-valid message when the token is wrong", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    )
      .get("/v1/health")
      .set("Authorization", "Bearer wrong");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: {
        code: "unauthenticated",
        message: "the bearer token is not valid",
      },
    });
  });

  it("treats a wrong scheme as a missing token", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    )
      .get("/v1/health")
      .set("Authorization", "Basic test-token");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: { code: "unauthenticated", message: "no bearer token" },
    });
  });

  it("answers 200 when the bearer token matches", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    )
      .get("/v1/health")
      .set("Authorization", "Bearer test-token");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });

  it("refuses every path and method with the same 401", async () => {
    const requests = [
      (await loopbackAgent(buildApp("test-token"))).get("/v1/health"),
      (await loopbackAgent(buildApp("test-token"))).get("/v1/anything"),
      (await loopbackAgent(buildApp("test-token"))).post("/v1/repository"),
      (await loopbackAgent(buildApp("test-token"))).delete("/v1/provider/x"),
    ];
    for (const pending of requests) {
      const response = await pending;
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, {
        error: { code: "unauthenticated", message: "no bearer token" },
      });
    }
  });

  it("passes every request when the configured token is empty", async () => {
    const bare = await (await loopbackAgent(buildApp(""))).get("/v1/health");
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.body, { reached: true });
    const withHeader = await (
      await loopbackAgent(buildApp(""))
    )
      .get("/v1/health")
      .set("Authorization", "Bearer anything");
    assert.equal(withHeader.status, 200);
    assert.deepEqual(withHeader.body, { reached: true });
  });
});

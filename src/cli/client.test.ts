import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRequest, call, type ClientDependencies } from "./client.ts";
import { KANTHORD_VERSION } from "../domain/version.ts";
import { CliError } from "./options.ts";
import { exitCodeForError } from "./exit-code.ts";

const stubFetch = (
  respond: (url: string, init: RequestInit) => Response,
): {
  fetch: typeof globalThis.fetch;
  calls: readonly Readonly<{ url: string; init: RequestInit }>[];
} => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return Promise.resolve(respond(url, requestInit));
  };
  return { fetch, calls };
};

const truncatedResponse = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"proj'));
        controller.error(new Error("the body stream reset"));
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const headersOf = (init: RequestInit): Readonly<Record<string, string>> =>
  init.headers as Readonly<Record<string, string>>;

const dependencies = (
  overrides: Partial<ClientDependencies> = {},
): ClientDependencies => ({
  baseUrl: "http://127.0.0.1:7421",
  token: "t",
  fetch: async () => new Response(null),
  ...overrides,
});

describe("src/cli/client.test", () => {
  it("buildRequest renders system.db over the base url", () => {
    const request = buildRequest(dependencies(), { operationId: "system.db" });

    assert.equal(request.url, "http://127.0.0.1:7421/v1/db/status");
    assert.equal(request.init.method, "GET");
  });

  it("a trailing slash is stripped from the base url", () => {
    const one = buildRequest(
      dependencies({ baseUrl: "http://127.0.0.1:7421/" }),
      { operationId: "system.db" },
    );
    const many = buildRequest(
      dependencies({ baseUrl: "http://127.0.0.1:7421///" }),
      { operationId: "system.db" },
    );

    assert.equal(one.url, "http://127.0.0.1:7421/v1/db/status");
    assert.equal(many.url, "http://127.0.0.1:7421/v1/db/status");
  });

  it("buildRequest substitutes a path parameter", () => {
    const request = buildRequest(dependencies(), {
      operationId: "node.show",
      parameters: { id: "task_01JQ8ZAN9P" },
    });

    assert.ok(request.url.endsWith("/v1/node/task_01JQ8ZAN9P"));
  });

  it("buildRequest renders query members into the url", () => {
    const request = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { limit: "200" },
    });

    assert.equal(request.url, "http://127.0.0.1:7421/v1/event?limit=200");
  });

  it("buildRequest percent-encodes reserved characters in query names and values", () => {
    const request = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { q: "a b&c=d", "na#me": "x+y" },
    });

    assert.equal(
      request.url,
      "http://127.0.0.1:7421/v1/event?na%23me=x%2By&q=a%20b%26c%3Dd",
    );
  });

  it("buildRequest appends no query string when query is absent or fully skipped", () => {
    const absent = buildRequest(dependencies(), { operationId: "event.list" });

    assert.equal(absent.url, "http://127.0.0.1:7421/v1/event");

    const skipped = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { limit: undefined },
    });

    assert.equal(skipped.url, "http://127.0.0.1:7421/v1/event");
  });

  it("buildRequest appends the query keys in bytewise order", () => {
    const request = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { state: "ready", kind: "task" },
    });

    assert.equal(
      request.url,
      "http://127.0.0.1:7421/v1/event?kind=task&state=ready",
    );
  });

  it("buildRequest skips an undefined value", () => {
    const request = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { state: "ready", kind: undefined },
    });

    assert.equal(request.url, "http://127.0.0.1:7421/v1/event?state=ready");
  });

  it("buildRequest percent-encodes a value that holds a space", () => {
    const request = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { q: "a b" },
    });

    assert.equal(request.url, "http://127.0.0.1:7421/v1/event?q=a%20b");
  });

  it("buildRequest writes the Idempotency-Key header when present and omits it when absent", () => {
    const withKey = buildRequest(dependencies(), {
      operationId: "event.list",
      idempotencyKey: "a".repeat(32),
    });
    assert.equal(headersOf(withKey.init)["Idempotency-Key"], "a".repeat(32));

    const withoutKey = buildRequest(dependencies(), {
      operationId: "event.list",
    });
    assert.equal(
      Object.hasOwn(headersOf(withoutKey.init), "Idempotency-Key"),
      false,
    );
  });

  it("a rendered query round-trips through URL parsing to the original values", () => {
    const request = buildRequest(dependencies(), {
      operationId: "event.list",
      query: { q: "a&b=c#d e" },
    });

    const parsed = new URL(request.url);
    assert.equal(parsed.searchParams.get("q"), "a&b=c#d e");
  });

  it("a parameter is not percent-encoded", () => {
    const request = buildRequest(dependencies(), {
      operationId: "blob.show",
      parameters: { hash: "sha256:9f2a" },
    });

    assert.ok(request.url.endsWith("/v1/blob/sha256:9f2a"));
    assert.equal(request.url.includes("%3A"), false);
  });

  it("a parameter value that would need encoding is refused", () => {
    for (const parameters of [
      { id: "a/b" },
      { id: "a?b" },
      { id: "a b" },
      { id: "" },
    ]) {
      assert.throws(
        () =>
          buildRequest(dependencies(), {
            operationId: "node.show",
            parameters,
          }),
        (err: unknown) => !(err instanceof CliError) && err instanceof Error,
        `parameter ${JSON.stringify(parameters)}`,
      );
    }
  });

  it("init.headers always carries X-Kanthord-Client and Accept", () => {
    const withToken = buildRequest(dependencies(), {
      operationId: "system.db",
    });
    const headersWithToken = headersOf(withToken.init);
    assert.equal(headersWithToken["X-Kanthord-Client"], KANTHORD_VERSION);
    assert.equal(headersWithToken["Accept"], "application/json");

    const withoutToken = buildRequest(dependencies({ token: undefined }), {
      operationId: "system.db",
    });
    const headersWithoutToken = headersOf(withoutToken.init);
    assert.equal(headersWithoutToken["X-Kanthord-Client"], KANTHORD_VERSION);
    assert.equal(headersWithoutToken["Accept"], "application/json");
  });

  it("Authorization is carried only when the token is a string", () => {
    const withToken = buildRequest(dependencies(), {
      operationId: "system.db",
    });
    assert.equal(headersOf(withToken.init)["Authorization"], "Bearer t");

    const withoutToken = buildRequest(dependencies({ token: undefined }), {
      operationId: "system.db",
    });
    assert.equal(
      Object.hasOwn(headersOf(withoutToken.init), "Authorization"),
      false,
    );
  });

  it("init.headers never carries an Origin key", () => {
    const cases = [
      dependencies(),
      dependencies({ token: undefined }),
      dependencies({ baseUrl: "http://127.0.0.1:7421///" }),
    ];
    for (const deps of cases) {
      const request = buildRequest(deps, { operationId: "system.db" });
      const headers = headersOf(request.init);
      assert.equal(Object.hasOwn(headers, "Origin"), false);
      assert.equal(Object.hasOwn(headers, "origin"), false);
    }
  });

  it("a body sets Content-Type and JSON.stringify output", () => {
    const body = { migrations: [] };
    const request = buildRequest(dependencies(), {
      operationId: "system.db",
      body,
    });

    assert.equal(headersOf(request.init)["Content-Type"], "application/json");
    assert.equal(request.init.body, JSON.stringify(body));
  });

  it("no body leaves both keys absent", () => {
    const request = buildRequest(dependencies(), { operationId: "system.db" });

    assert.equal(Object.hasOwn(headersOf(request.init), "Content-Type"), false);
    assert.equal(request.init.body, undefined);
  });

  it("an unknown operation id throws a plain Error", () => {
    assert.throws(
      () => buildRequest(dependencies(), { operationId: "nope.invented" }),
      (err: unknown) => !(err instanceof CliError) && err instanceof Error,
    );
  });

  it("a declared parameter omitted from the input throws a plain Error", () => {
    assert.throws(
      () => buildRequest(dependencies(), { operationId: "node.show" }),
      (err: unknown) => !(err instanceof CliError) && err instanceof Error,
    );
  });

  it("call on a 200 JSON response returns ok with the parsed body", async () => {
    const body = { migrations: [] };
    const { fetch, calls } = stubFetch(() => jsonResponse(body, 200));
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, body);
    }
    assert.equal(calls.length, 1);
  });

  it("call on a 200 response with malformed JSON resolves ok with the raw text and never throws", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response('{"oops', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 200);
      assert.equal(result.body, '{"oops');
    }
  });

  it("call on a 200 text response returns ok with the text body", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response("plain", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 200);
      assert.equal(result.body, "plain");
    }
  });

  it("call on a 200 response with no content type returns ok with the text body", async () => {
    const { fetch } = stubFetch(() => new Response("raw", { status: 200 }));
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 200);
      assert.equal(result.body, "raw");
    }
  });

  it("call on a 204 no-content response returns ok with an empty body", async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 204 }));
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, 204);
      assert.equal(result.body, "");
    }
  });

  it("call on a refusal with a non-json content type returns the fallback", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response("<html>oops</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.status, 502);
      assert.equal(result.code, "envelope-unreadable");
      assert.equal(
        result.message,
        "the daemon answered 502 with no error envelope",
      );
      assert.equal(exitCodeForError(result.code, result.status), 200);
    }
  });

  it("call on a 404 envelope returns ok false with the code and message", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "not-found",
            message: "no operation for GET /v1/nope",
          },
        },
        404,
      ),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.status, 404);
      assert.equal(result.code, "not-found");
      assert.equal(result.message, "no operation for GET /v1/nope");
      assert.equal(result.details, undefined);
    }
  });

  it("call on a 409 envelope returns the details", async () => {
    const details = { expected: "a", actual: "b" };
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { error: { code: "stale-revision", message: "moved", details } },
        409,
      ),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.deepEqual(result.details, details);
    }
  });

  it("call never throws on a malformed daemon response", async () => {
    const malformed = ["<h1>oops</h1>", '{"error":', "", '{"message":"nope"}'];
    for (const body of malformed) {
      const { fetch } = stubFetch(() => {
        const text = body as string;
        return new Response(text, {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      });
      const result = await call(dependencies({ fetch }), {
        operationId: "system.db",
      });

      if (result.ok) {
        assert.fail(`expected a refused result for ${JSON.stringify(body)}`);
      } else {
        assert.equal(result.status, 500, `body ${JSON.stringify(body)}`);
        assert.equal(
          result.code,
          "internal-error",
          `body ${JSON.stringify(body)}`,
        );
        assert.equal(
          result.message,
          "the daemon answered 500 with no error envelope",
          `body ${JSON.stringify(body)}`,
        );
      }
    }
  });

  it("an unknown code is returned unchanged and falls to the category floor", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { error: { code: "invented-future-code", message: "later" } },
        409,
      ),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "invented-future-code");
      assert.equal(exitCodeForError(result.code, result.status), 100);
    }
  });

  it("a 501 envelope pairs with exit code 220", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "not-implemented",
            message: "system.status ships in phase-1",
          },
        },
        501,
      ),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "not-implemented");
      assert.equal(exitCodeForError(result.code, result.status), 220);
    }
  });

  it("an unreachable daemon pairs with exit code 2 and names the base url", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = new Error("connect ECONNREFUSED 127.0.0.1:7421");
    const result = await call(
      dependencies({
        fetch: () => Promise.reject(failure),
      }),
      { operationId: "system.db" },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "transport-failure");
      assert.equal(result.status, 0);
      assert.equal(
        result.message,
        "cannot reach the daemon at http://127.0.0.1:7421: connect ECONNREFUSED 127.0.0.1:7421",
      );
      assert.equal(result.details, undefined);
      assert.equal(exitCodeForError(result.code, result.status), 2);
    }
  });

  it("a socket failure after a POST is dispatched pairs with exit code 3", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const result = await call(
      dependencies({ fetch: () => Promise.reject(failure) }),
      { operationId: "project.create", body: { name: "p" } },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "outcome-indeterminate");
      assert.equal(result.status, 0);
      assert.equal(
        result.message,
        "the daemon at http://127.0.0.1:7421 did not answer project.create, so the operation may have committed: socket hang up",
      );
      assert.equal(exitCodeForError(result.code, result.status), 3);
    }
  });

  it("a refused connection on a POST stays exit code 2, because nothing was dispatched", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:7421"),
      { code: "ECONNREFUSED" },
    );
    const result = await call(
      dependencies({ fetch: () => Promise.reject(failure) }),
      { operationId: "project.create", body: { name: "p" } },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "transport-failure");
      assert.equal(exitCodeForError(result.code, result.status), 2);
    }
  });

  it("a socket failure on a GET stays exit code 2, because a read changes nothing", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const result = await call(
      dependencies({ fetch: () => Promise.reject(failure) }),
      { operationId: "system.db" },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "transport-failure");
      assert.equal(exitCodeForError(result.code, result.status), 2);
    }
  });

  it("a body that ends early after a POST answers 200 pairs with exit code 3", async () => {
    const result = await call(
      dependencies({ fetch: () => Promise.resolve(truncatedResponse()) }),
      { operationId: "project.create", body: { name: "p" } },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "outcome-indeterminate");
      assert.equal(result.status, 200);
      assert.equal(
        result.message,
        "the daemon at http://127.0.0.1:7421 answered 200 and the body ended early, so project.create may have committed: the body stream reset",
      );
      assert.equal(exitCodeForError(result.code, result.status), 3);
    }
  });

  it("a body that ends early after a GET answers 200 stays exit code 2", async () => {
    const result = await call(
      dependencies({ fetch: () => Promise.resolve(truncatedResponse()) }),
      { operationId: "system.db" },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "transport-failure");
      assert.equal(
        result.message,
        "the daemon at http://127.0.0.1:7421 answered 200 and the body ended early: the body stream reset",
      );
      assert.equal(exitCodeForError(result.code, result.status), 2);
    }
  });

  it("an unreadable envelope on a 409 names no declared code and exits 100", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response("<html>proxy</html>", {
          status: 409,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "envelope-unreadable");
      assert.equal(exitCodeForError(result.code, result.status), 100);
    }
  });

  it("an unreadable envelope on a 401 still names unauthenticated, the one code that status carries", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response("<html>proxy</html>", {
          status: 401,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const result = await call(dependencies({ fetch }), {
      operationId: "system.db",
    });

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(result.code, "unauthenticated");
      assert.equal(exitCodeForError(result.code, result.status), 120);
    }
  });

  it("a transport failure with no cause reports the error message itself", async () => {
    const result = await call(
      dependencies({
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      }),
      { operationId: "system.db" },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(
        result.message,
        "cannot reach the daemon at http://127.0.0.1:7421: fetch failed",
      );
    }
  });

  it("a transport failure of a non-error rejection renders the value", async () => {
    const result = await call(
      dependencies({
        fetch: () => Promise.reject("socket gone"),
      }),
      { operationId: "system.db" },
    );

    if (result.ok) {
      assert.fail("expected a refused result");
    } else {
      assert.equal(
        result.message,
        "cannot reach the daemon at http://127.0.0.1:7421: socket gone",
      );
    }
  });
});

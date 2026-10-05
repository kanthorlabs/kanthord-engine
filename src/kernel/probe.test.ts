import assert from "node:assert/strict";
import { test } from "node:test";
import { background, CancellationContext, type Context } from "./context.ts";
import { ResourceStatus } from "./health.ts";
import { HttpMethod, HttpStatus } from "./http.ts";
import {
  AUTHORIZATION_HEADER,
  headerSecrets,
  probeHttp,
  redactReason,
  thrownReason,
} from "./probe.ts";

const SECRET = "test_private-resource-health-secret";
const URL = "https://probe.example/v1/check";
const HEADERS = { [AUTHORIZATION_HEADER]: `Bearer ${SECRET}` };
const NO_CALLS = 0;
const ONE_CALL = 1;
const REASON_LIMIT = 300;

const check = (context: Context) => probeHttp(URL, HEADERS, context);

{
  for (const [status, expected] of [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
    [HttpStatus.InternalServerError, ResourceStatus.Unhealthy],
  ] as const) {
    test(`probeHttp maps HTTP ${status}, sends the expected request and releases the body`, async (t) => {
      const cancel = t.mock.fn();
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async (
          url: Parameters<typeof globalThis.fetch>[0],
          options?: RequestInit,
        ) => {
          assert.equal(url, URL);
          assert.equal(options?.method, HttpMethod.Get);
          assert.deepEqual(options?.headers, HEADERS);
          assert.ok(options?.signal instanceof AbortSignal);
          return new Response(new ReadableStream({ cancel }), { status });
        },
      );
      const result = await check(background);
      assert.equal(result, expected);
      assert.equal(fetch.mock.callCount(), ONE_CALL);
      assert.equal(cancel.mock.callCount(), ONE_CALL);
      assert.ok(!result.includes(SECRET));
    });
  }

  test(`probeHttp hides network errors`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error(SECRET);
    });
    const result = await check(background);
    assert.equal(result, ResourceStatus.Unknown);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });

  test(`probeHttp skips cancelled and expired contexts`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected request");
    });
    const cancelled = new CancellationContext();
    cancelled.cancel();
    const expired = new CancellationContext(background, Date.now());
    assert.equal(await check(cancelled), ResourceStatus.Unknown);
    assert.equal(await check(expired), ResourceStatus.Unknown);
    assert.equal(fetch.mock.callCount(), NO_CALLS);
  });

  test(`probeHttp aborts an in-flight request and disposes the context bridge`, async (t) => {
    const context = new CancellationContext();
    const entered = Promise.withResolvers<AbortSignal>();
    const dispose = t.mock.fn();
    const original = context.onCancel.bind(context);
    t.mock.method(context, "onCancel", (listener: (error: Error) => void) => {
      const unsubscribe = original(listener);
      return () => {
        unsubscribe();
        dispose();
      };
    });
    t.after(() => context.cancel());
    t.mock.method(
      globalThis,
      "fetch",
      (_url: Parameters<typeof globalThis.fetch>[0], options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options!.signal!;
          signal.addEventListener("abort", () => reject(new Error(SECRET)), {
            once: true,
          });
          entered.resolve(signal);
        }),
    );
    const pending = check(context);
    const signal = await entered.promise;
    context.cancel();
    assert.equal(await pending, ResourceStatus.Unknown);
    assert.equal(signal.aborted, true);
    assert.equal(dispose.mock.callCount(), ONE_CALL);
  });
}

test("redactReason removes secrets, bearer values, JWTs and long tokens and bounds the length", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
  const reason = redactReason(
    `failed ${SECRET} Bearer abc.def ${jwt} ${"A".repeat(400)}`,
    [SECRET],
  );
  assert.ok(!reason.includes(SECRET));
  assert.ok(!reason.includes("abc.def"));
  assert.ok(!reason.includes(jwt));
  assert.ok(reason.length <= REASON_LIMIT);
});

test("thrownReason removes a short bare secret of a header value", () => {
  const short = "ghp_short1";
  const headers = {
    [AUTHORIZATION_HEADER]: `Bearer ${short}`,
    "x-api-key": short,
  };
  const reason = thrownReason(
    new Error(`request failed for ${short}`),
    headerSecrets(headers),
  );
  assert.ok(!reason.includes(short));
});

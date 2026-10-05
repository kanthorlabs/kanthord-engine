import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { probeS3 } from "./probe.ts";

const SECRET = "test_private-resource-health-secret";
const ACCESS_KEY_ID = "test_private-s3-access-id";
const ENDPOINT = "https://storage.example";
const BUCKET = "test-bucket";
const REGION = "us-east-1";
const ONE_CALL = 1;

const s3Check = (
  context: Context,
  createClient: NonNullable<Parameters<typeof probeS3>[6]>,
) =>
  probeS3(
    ACCESS_KEY_ID,
    SECRET,
    ENDPOINT,
    BUCKET,
    REGION,
    context,
    createClient,
  );

for (const throws of [false, true]) {
  for (const [status, expected] of [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.NotFound, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
    [HttpStatus.Unauthorized, ResourceStatus.Unknown],
    [HttpStatus.InternalServerError, ResourceStatus.Unknown],
  ] as const) {
    test(`S3 maps ${status} from ${throws ? "error" : "response"} and destroys the client`, async (t) => {
      const destroy = t.mock.fn();
      const send = t.mock.fn(
        async (
          command: HeadBucketCommand,
          options: { abortSignal: AbortSignal },
        ) => {
          assert.ok(command instanceof HeadBucketCommand);
          assert.deepEqual(command.input, { Bucket: BUCKET });
          assert.equal(options.abortSignal.aborted, false);
          const response = { $metadata: { httpStatusCode: status } };
          if (throws) throw Object.assign(new Error(SECRET), response);
          return response;
        },
      );
      const result = await s3Check(background, (config) => {
        assert.deepEqual(config, {
          endpoint: ENDPOINT,
          region: REGION,
          credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
        });
        return { send, destroy };
      });
      assert.equal(result, expected);
      assert.equal(send.mock.callCount(), ONE_CALL);
      assert.equal(destroy.mock.callCount(), ONE_CALL);
      assert.ok(!result.includes(SECRET));
      assert.ok(!result.includes(ACCESS_KEY_ID));
    });
  }
}

test("S3 network, construction and cleanup errors remain unknown without leaking secrets", async (t) => {
  const destroy = t.mock.fn();
  assert.equal(
    await s3Check(background, () => ({
      send: async () => {
        throw new Error(SECRET);
      },
      destroy,
    })),
    ResourceStatus.Unknown,
  );
  assert.equal(destroy.mock.callCount(), ONE_CALL);
  assert.equal(
    await s3Check(background, () => {
      throw new Error(SECRET);
    }),
    ResourceStatus.Unknown,
  );
  assert.equal(
    await s3Check(background, () => ({
      send: async () => ({ $metadata: { httpStatusCode: HttpStatus.OK } }),
      destroy: () => {
        throw new Error(SECRET);
      },
    })),
    ResourceStatus.Unknown,
  );
});

test("S3 skips cancelled contexts and aborts an in-flight request, destroying its client", async (t) => {
  const context = new CancellationContext();
  t.after(() => context.cancel());
  const entered = Promise.withResolvers<AbortSignal>();
  const destroy = t.mock.fn();
  const createClient = t.mock.fn(() => ({
    send: async (
      _command: HeadBucketCommand,
      options: { abortSignal: AbortSignal },
    ) =>
      new Promise((_resolve, reject) => {
        entered.resolve(options.abortSignal);
        options.abortSignal.addEventListener(
          "abort",
          () => reject({ $metadata: { httpStatusCode: HttpStatus.NotFound } }),
          { once: true },
        );
      }),
    destroy,
  }));
  const pending = s3Check(context, createClient);
  const signal = await entered.promise;
  context.cancel();
  assert.equal(await pending, ResourceStatus.Unknown);
  assert.equal(signal.aborted, true);
  assert.equal(destroy.mock.callCount(), ONE_CALL);
  assert.equal(await s3Check(context, createClient), ResourceStatus.Unknown);
  const expired = new CancellationContext(background, Date.now());
  assert.equal(await s3Check(expired, createClient), ResourceStatus.Unknown);
  assert.equal(createClient.mock.callCount(), ONE_CALL);
});

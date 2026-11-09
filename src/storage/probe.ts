import {
  HeadBucketCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { Context } from "../kernel/context.ts";
import {
  ResourceFailureReason,
  type ResourceObserver,
  ResourceStatus,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { failureReasonOfStatus, thrownReason } from "../kernel/probe.ts";
import { isNumber, isObject } from "../kernel/values.ts";

type BucketClient = {
  send(
    command: HeadBucketCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<unknown>;
  destroy(): void;
};
type CreateBucketClient = (config: S3ClientConfig) => BucketClient;

interface StatusCodeResponse {
  readonly $metadata: { readonly httpStatusCode: unknown };
}

function hasStatusCode(value: unknown): value is StatusCodeResponse {
  return (
    isObject(value) &&
    "$metadata" in value &&
    isObject(value.$metadata) &&
    "httpStatusCode" in value.$metadata
  );
}

function bucketStatus(
  value: unknown,
  secrets: readonly string[],
  observe?: ResourceObserver,
): ResourceStatusValue {
  if (!hasStatusCode(value)) {
    observe?.(thrownReason(value, secrets), ResourceFailureReason.Unreachable);
    return ResourceStatus.Unknown;
  }
  const status = value.$metadata.httpStatusCode;
  if (status === HttpStatus.OK) return ResourceStatus.Healthy;
  observe?.(
    `status=${String(status)}`,
    isNumber(status)
      ? failureReasonOfStatus(status)
      : ResourceFailureReason.Unreachable,
  );
  if (status === HttpStatus.NotFound) return ResourceStatus.Unhealthy;
  return ResourceStatus.Unknown;
}

async function headBucket(
  client: BucketClient,
  bucket: string,
  signal: AbortSignal,
  secrets: readonly string[],
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    const response = await client.send(
      new HeadBucketCommand({ Bucket: bucket }),
      {
        abortSignal: signal,
      },
    );
    return signal.aborted
      ? ResourceStatus.Unknown
      : bucketStatus(response, secrets, observe);
  } catch (error) {
    return signal.aborted
      ? ResourceStatus.Unknown
      : bucketStatus(error, secrets, observe);
  } finally {
    client.destroy();
  }
}

export async function probeS3(
  accessKeyId: string,
  secretAccessKey: string,
  endpoint: string,
  bucket: string,
  region: string,
  context: Context,
  createClient: CreateBucketClient = (config) => new S3Client(config),
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    const { signal } = context;
    if (signal.aborted) return ResourceStatus.Unknown;
    const client = createClient({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    return await headBucket(
      client,
      bucket,
      signal,
      [accessKeyId, secretAccessKey],
      observe,
    );
  } catch (error) {
    observe?.(
      thrownReason(error, [accessKeyId, secretAccessKey]),
      ResourceFailureReason.Unclassified,
    );
    return ResourceStatus.Unknown;
  }
}

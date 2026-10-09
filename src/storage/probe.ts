import {
  HeadBucketCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { abortSignal, type Context } from "../kernel/context.ts";
import {
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { thrownReason } from "../kernel/probe.ts";
import { isObject } from "../kernel/values.ts";

type BucketClient = {
  send(
    command: HeadBucketCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<unknown>;
  destroy(): void;
};
type CreateBucketClient = (config: S3ClientConfig) => BucketClient;

function bucketStatus(
  value: unknown,
  secrets: readonly string[],
  observe?: ResourceObserver,
): ResourceStatusValue {
  if (!isObject(value) || !("$metadata" in value)) {
    observe?.(thrownReason(value, secrets));
    return ResourceStatus.Unknown;
  }
  const metadata = value.$metadata;
  if (!isObject(metadata) || !("httpStatusCode" in metadata)) {
    observe?.(thrownReason(value, secrets));
    return ResourceStatus.Unknown;
  }
  if (metadata.httpStatusCode === HttpStatus.OK) return ResourceStatus.Healthy;
  observe?.(`status=${String(metadata.httpStatusCode)}`);
  if (metadata.httpStatusCode === HttpStatus.NotFound)
    return ResourceStatus.Unhealthy;
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
    const { signal, dispose } = abortSignal(context);
    try {
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
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(thrownReason(error, [accessKeyId, secretAccessKey]));
    return ResourceStatus.Unknown;
  }
}

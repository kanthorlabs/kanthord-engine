import { z } from "zod";
import {
  isNonblank,
  s3AccessKeySecretSchema,
  SecretShape,
  type CredentialPlatform,
} from "../custody/contract.ts";
import { probeS3 } from "./probe.ts";

export const Platform = {
  S3: "s3",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const CAPABILITY_BUCKET_HEAD = "bucket head";

export const s3MetadataSchema = z.strictObject({
  endpoint: z.url(),
  bucket: z.string().min(1).refine(isNonblank),
  region: z.string().min(1).refine(isNonblank),
});

export const STORAGE_PLATFORMS: Readonly<Record<Platform, CredentialPlatform>> =
  {
    [Platform.S3]: {
      secretShape: SecretShape.S3AccessKey,
      loginModes: [],
      metadataSchema: s3MetadataSchema,
      capability: CAPABILITY_BUCKET_HEAD,
      probe: (secret, metadata, context, observe) => {
        const { accessKeyId, secretAccessKey } =
          s3AccessKeySecretSchema.parse(secret);
        const { endpoint, bucket, region } = s3MetadataSchema.parse(metadata);
        return probeS3(
          accessKeyId,
          secretAccessKey,
          endpoint,
          bucket,
          region,
          context,
          undefined,
          observe,
        );
      },
    },
  };

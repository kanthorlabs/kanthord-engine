import assert from "node:assert/strict";
import { test } from "node:test";
import {
  credentialPlatformList,
  s3AccessKeySecretSchema,
  secretSchemas,
  SecretShape,
} from "../custody/contract.ts";
import { s3MetadataSchema, STORAGE_PLATFORMS } from "./platforms.ts";

const s3Metadata = {
  endpoint: "https://s3.example.com",
  bucket: "bucket",
  region: "us-east-1",
};

test("the platform list holds s3 alone with its secret shape and metadata fields", () => {
  assert.deepEqual(credentialPlatformList(STORAGE_PLATFORMS), {
    items: [
      {
        platform: "s3",
        secret_shape: SecretShape.S3AccessKey,
        login_modes: [],
        metadata_fields: ["endpoint", "bucket", "region"],
        verifiable: true,
      },
    ],
  });
  assert.equal(
    secretSchemas[STORAGE_PLATFORMS.s3.secret_shape],
    s3AccessKeySecretSchema,
  );
  assert.equal(STORAGE_PLATFORMS.s3.metadata_schema, s3MetadataSchema);
});

test("s3 metadata requires a URL and nonblank bucket and region", () => {
  assert.deepEqual(s3MetadataSchema.parse(s3Metadata), s3Metadata);
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, endpoint: "not-a-url" })
      .success,
    false,
  );
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, bucket: "  " }).success,
    false,
  );
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, region: "  " }).success,
    false,
  );
  assert.equal(
    s3MetadataSchema.safeParse({ ...s3Metadata, extra: 1 }).success,
    false,
  );
});

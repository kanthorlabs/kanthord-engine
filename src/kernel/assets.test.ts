import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PACKAGE_MANIFEST, packageManifest, shippedAsset } from "./assets.ts";

const ASSET_NAME = "prompt/base.md";
const EMBEDDED_CONTENT = "embedded";
const TEXT_ENCODING = "utf8";
const NO_CONTENT = 0;

test("outside a single executable the loader reads the static directory", () => {
  assert.equal(
    shippedAsset(ASSET_NAME),
    readFileSync(
      new URL(`../../static/${ASSET_NAME}`, import.meta.url),
      TEXT_ENCODING,
    ),
  );
});

test("inside a single executable the loader answers the embedded asset", () => {
  const requested: string[][] = [];
  const content = shippedAsset(ASSET_NAME, {
    isSea: () => true,
    getAsset: (name, encoding) => {
      requested.push([name, encoding]);
      return EMBEDDED_CONTENT;
    },
  });
  assert.equal(content, EMBEDDED_CONTENT);
  assert.deepEqual(requested, [[ASSET_NAME, TEXT_ENCODING]]);
});

test("outside a single executable the loader never asks the embedded source", () => {
  const content = shippedAsset(ASSET_NAME, {
    isSea: () => false,
    getAsset: () => assert.fail("embedded asset requested"),
  });
  assert.ok(content.length > NO_CONTENT);
});

test("outside a single executable the manifest loader reads the package manifest", () => {
  assert.equal(
    packageManifest(),
    readFileSync(
      new URL(`../../${PACKAGE_MANIFEST}`, import.meta.url),
      TEXT_ENCODING,
    ),
  );
});

test("inside a single executable the manifest loader answers the embedded manifest", () => {
  const requested: string[][] = [];
  const content = packageManifest({
    isSea: () => true,
    getAsset: (name, encoding) => {
      requested.push([name, encoding]);
      return EMBEDDED_CONTENT;
    },
  });
  assert.equal(content, EMBEDDED_CONTENT);
  assert.deepEqual(requested, [[PACKAGE_MANIFEST, TEXT_ENCODING]]);
});

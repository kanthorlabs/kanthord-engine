import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  DASHBOARD_ASSET_PREFIX,
  dashboardAsset,
  PI_TOOLS_ASSET_PREFIX,
  piToolAsset,
  shippedAsset,
  workerThreadAsset,
} from "./assets.ts";
import { temporary } from "./test-support.ts";

const ASSET_NAME = "prompt/base.md";
const EMBEDDED_CONTENT = "embedded";
const TEXT_ENCODING = "utf8";

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
  const content = shippedAsset(ASSET_NAME, {
    isSea: () => true,
    getAsset: () => EMBEDDED_CONTENT,
  });
  assert.equal(content, EMBEDDED_CONTENT);
});

test("inside a single executable the dashboard loader answers the prefixed asset", () => {
  const bytes = new TextEncoder().encode(EMBEDDED_CONTENT).buffer;
  const requested: string[] = [];
  const source = {
    isSea: () => true,
    getAssetKeys: () => [`${DASHBOARD_ASSET_PREFIX}index.html`],
    getAsset: (name: string) => {
      requested.push(name);
      return bytes;
    },
  };
  assert.equal(dashboardAsset("index.html", source), bytes);
  assert.equal(dashboardAsset("missing.js", source), undefined);
  assert.deepEqual(requested, [`${DASHBOARD_ASSET_PREFIX}index.html`]);
});

test("outside a single executable the pi tool loader reads the target directory", (t) => {
  const root = temporary(t);
  mkdirSync(join(root, "darwin-arm64", "bin"), { recursive: true });
  writeFileSync(join(root, "darwin-arm64", "bin", "fd"), EMBEDDED_CONTENT);
  const directory = pathToFileURL(`${root}/`);
  const source = {
    isSea: () => false,
    getAssetKeys: () => assert.fail("asset keys requested"),
    getAsset: () => assert.fail("embedded asset requested"),
  };
  assert.equal(
    piToolAsset("darwin-arm64", "bin/fd", source, directory)?.toString(),
    EMBEDDED_CONTENT,
  );
  assert.equal(
    piToolAsset("linux-x64", "bin/fd", source, directory),
    undefined,
  );
});

test("inside a single executable the pi tool loader answers the prefixed asset", () => {
  const bytes = new TextEncoder().encode(EMBEDDED_CONTENT).buffer;
  const requested: string[] = [];
  const source = {
    isSea: () => true,
    getAssetKeys: () => [`${PI_TOOLS_ASSET_PREFIX}bin/fd`],
    getAsset: (name: string) => {
      requested.push(name);
      return bytes;
    },
  };
  assert.equal(
    piToolAsset("darwin-arm64", "bin/fd", source)?.toString(),
    EMBEDDED_CONTENT,
  );
  assert.equal(piToolAsset("darwin-arm64", "bin/rg", source), undefined);
  assert.deepEqual(requested, [`${PI_TOOLS_ASSET_PREFIX}bin/fd`]);
});

test("inside a single executable the worker thread loader answers the embedded bundle", () => {
  const source = workerThreadAsset({
    isSea: () => true,
    getAsset: () => EMBEDDED_CONTENT,
  });
  assert.equal(source, EMBEDDED_CONTENT);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const productPath = resolve(
  import.meta.dirname,
  "../../podman/product.Containerfile",
);
const fixturePath = resolve(
  import.meta.dirname,
  "../../podman/fixture.Containerfile",
);

const productText = readFileSync(productPath, "utf8");
const fixtureText = readFileSync(fixturePath, "utf8");

test("both Containerfiles begin FROM docker.io/library/node:24-bookworm@sha256:, digest-qualified", () => {
  for (const text of [productText, fixtureText]) {
    assert.match(
      text,
      /^FROM docker\.io\/library\/node:24-bookworm@sha256:[0-9a-f]{64}/,
    );
  }
});

test("neither Containerfile contains apt-get, npm install, npm ci, curl or wget", () => {
  for (const text of [productText, fixtureText]) {
    for (const banned of ["apt-get", "npm install", "npm ci", "curl", "wget"]) {
      assert.equal(text.includes(banned), false, `${banned} found`);
    }
  }
});

test("the two COPY source trees are disjoint: product copies no path under fixture, fixture copies no path under product", () => {
  const productCopySources = [...productText.matchAll(/^COPY\s+(\S+)/gm)].map(
    (match) => match[1],
  );
  const fixtureCopySources = [...fixtureText.matchAll(/^COPY\s+(\S+)/gm)].map(
    (match) => match[1],
  );

  assert.ok(productCopySources.length > 0);
  assert.ok(fixtureCopySources.length > 0);

  for (const source of productCopySources) {
    assert.equal(
      source?.startsWith("fixture"),
      false,
      `${source} is under fixture`,
    );
  }
  for (const source of fixtureCopySources) {
    assert.equal(
      source?.startsWith("product"),
      false,
      `${source} is under product`,
    );
  }
});

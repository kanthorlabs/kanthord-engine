import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnder } from "./run-agent-paths.ts";

test("isUnder returns true for a path starting with the directory prefix", () => {
  assert.equal(isUnder("/a/b/c", "/a/b"), true);
});

test("isUnder returns true when path equals dir", () => {
  assert.equal(isUnder("/a/b", "/a/b"), true);
});

test("isUnder returns false when path does not start with the directory prefix", () => {
  assert.equal(isUnder("/a/bc", "/a/b"), false);
});

test("isUnder returns true for every absolute path when dir is root", () => {
  assert.equal(isUnder("/any/path", "/"), true);
});

test("isUnder returns false for a relative path when dir is root", () => {
  assert.equal(isUnder("relative/path", "/"), false);
});

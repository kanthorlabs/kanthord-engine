import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { gateFilesOf } from "./gate-files.ts";

const BINDING_ID = createIdentity("binding");
const OTHER_BINDING_ID = createIdentity("binding");
const PATHS = ["package.json", "pnpm-lock.yaml"];
const ASSESSMENT = {
  gate_files: canonicalJSON([{ binding_id: BINDING_ID, paths: PATHS }]),
};

test("gateFilesOf returns the paths of the binding", () => {
  assert.deepEqual(gateFilesOf(ASSESSMENT, BINDING_ID), PATHS);
});

test("gateFilesOf returns no path for a null assessment", () => {
  assert.deepEqual(gateFilesOf(null, BINDING_ID), []);
});

test("gateFilesOf returns no path for a null column", () => {
  assert.deepEqual(gateFilesOf({ gate_files: null }, BINDING_ID), []);
});

test("gateFilesOf returns no path for another binding", () => {
  assert.deepEqual(gateFilesOf(ASSESSMENT, OTHER_BINDING_ID), []);
});

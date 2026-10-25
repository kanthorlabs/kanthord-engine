import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { missionOperations } from "./contract.ts";
import { missionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const OPERATION = "evidence.delete";
const EXPECTED_VERSION = 1;
const ONE_COMMIT = 1;
const STRAY_VALUE = "stray";

function input() {
  return {
    params: { evidence_id: createIdentity("evidence") },
    query: {},
    body: { expected_mission_version: EXPECTED_VERSION, force: false },
  };
}

function handlerOf(h: ReturnType<typeof missionHarness>) {
  return h.registry.get(missionOperations[OPERATION].id);
}

test("invoke answers the parsed commit body and ignores another handler return", async (t) => {
  const h = missionHarness(t, IDENTITY);
  handlerOf(h).handler = (_input, caller) => {
    caller.commit(() => null);
    return STRAY_VALUE;
  };
  assert.equal(await h.invoke(OPERATION, input()), null);
  assert.equal(h.commits(), ONE_COMMIT);
});

test("invoke parses the handler return with the output schema when the handler did not commit through the wrapped caller", async (t) => {
  const h = missionHarness(t, IDENTITY);
  const entry = handlerOf(h);
  entry.handler = () => {
    h.caller.commit(() => null);
    return STRAY_VALUE;
  };
  await assert.rejects(h.invoke(OPERATION, input()), ZodError);
  entry.handler = () => {
    h.caller.commit(() => null);
    return null;
  };
  assert.equal(await h.invoke(OPERATION, input()), null);
});

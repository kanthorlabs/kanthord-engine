import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { AssetKind, MissionErrorCode } from "./contract.ts";
import { unavailableStorage } from "./storage-unavailable.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const SINGLE_ITEM = 1;
const NO_ITEMS = 0;

function unavailable(error: unknown): boolean {
  return (
    error instanceof OperationError &&
    error.status === HttpStatus.ServiceUnavailable &&
    error.code === MissionErrorCode.EvidenceStorageUnavailable
  );
}

test("every unwired storage method answers the declared unavailable error", async () => {
  for (const method of Object.values(unavailableStorage))
    await assert.rejects(async () => method(), unavailable);
});

test("an object submit without wired storage answers unavailable and writes no evidence", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  h.dependencies.intakeStorage = unavailableStorage;
  await assert.rejects(
    h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.context,
        subject: "Object",
        assets: [
          {
            kind: AssetKind.Object,
            size: SINGLE_ITEM,
            media_type: "text/plain",
          },
        ],
      },
    }),
    unavailable,
  );
  const count = h.store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT COUNT(*) AS count FROM mission_evidence")
        .get() as { count: number },
  );
  assert.equal(count.count, NO_ITEMS);
});

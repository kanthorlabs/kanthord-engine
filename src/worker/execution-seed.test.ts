import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import type { SeedExecution, SeedSources } from "./contract.ts";
import { seedDependencies } from "./execution-seed.ts";
import type { Dependencies } from "./service.ts";

const PINNED = createIdentity("credential");
const CREDENTIAL = "anthro-1";
const PUBLIC_KEY = "ssh-ed25519 AAAA seed";
const NOW = 1000;
const TX = {} as Transaction;

const execution: SeedExecution = {
  execution_id: createIdentity("execution"),
  project_id: createIdentity("project"),
  node_id: createIdentity("node"),
  attempt: 1,
  pinned_revision: 1,
  node_branch: "kanthord/node",
  runtime_identity: createIdentity("worker_registration"),
  worker_binding_id: createIdentity("binding"),
  credentials: [PINNED],
  created_at: NOW,
  expired_at: NOW + NOW,
  trace_id: "trace",
  root_span_id: "1".repeat(16),
};

test("the seed composition claims no environment, stores no prompt record and reads only the pinned credentials with no running claim and no drain", () => {
  const refused = (name: string) => () => assert.fail(`${name} was called`);
  const dependencies = {
    environmentClaimed: refused("environmentClaimed"),
    pinnedCredentialMetadata: refused("pinnedCredentialMetadata"),
    promptTelemetry: {
      agentPrompted: refused("agentPrompted"),
      promptRecordOf: () => null,
    },
    custodyHandover: { sshPublicKeyOf: refused("sshPublicKeyOf") },
  } as unknown as Dependencies;
  const reads: [readonly string[], string][] = [];
  const seeds = {
    credentialMetadataOf: (_tx, pinned, name) => {
      reads.push([pinned, name]);
      return { id: PINNED };
    },
    sshPublicKeyOf: (_tx, pinned, name) => {
      reads.push([pinned, name]);
      return PUBLIC_KEY;
    },
  } as SeedSources;
  const seeded = seedDependencies(dependencies, seeds, execution);
  const claim = { executionId: execution.execution_id } as never;
  seeded.environmentClaimed(execution.project_id, "environment");
  const facts = { agent_name: "swe@1" } as never;
  seeded.promptTelemetry.agentPrompted(execution.execution_id, facts);
  assert.equal(
    seeded.promptTelemetry.promptRecordOf(execution.execution_id, "swe@1"),
    facts,
  );
  assert.deepEqual(
    seeded.pinnedCredentialMetadata(TX, claim, CREDENTIAL, NOW),
    { id: PINNED },
  );
  assert.equal(
    seeded.custodyHandover.sshPublicKeyOf(TX, claim, CREDENTIAL, NOW),
    PUBLIC_KEY,
  );
  assert.deepEqual(reads, [
    [[PINNED], CREDENTIAL],
    [[PINNED], CREDENTIAL],
  ]);
});

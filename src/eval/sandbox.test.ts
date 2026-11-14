import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentOperations } from "../agent/contract.ts";
import { workbenchOperations } from "../workbench/contract.ts";
import { llmOperations } from "../llm/contract.ts";
import { ANTHROPIC_SUBSCRIPTION_PLATFORM } from "../kernel/pi-provider.ts";
import { temporary } from "../kernel/test-support.ts";
import { CredentialSourceKind } from "./credential.ts";
import { EVAL_CONFIGURATION } from "./run.ts";
import { openSandbox } from "./sandbox.ts";

const SUBJECT = "ops@1";
const TEST_TIMEOUT_MS = 60000;
const FAR_EXPIRY_MS = 86400000;
const NATIVE_CREDENTIAL = "native-credential";

test(
  "the subscription source creates an anthropic-subscription credential and a valid subject enablement",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const path = join(temporary(t), "auth.json");
    writeFileSync(
      path,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "eval-access-value",
          refresh: "eval-refresh-value",
          expires: Date.now() + FAR_EXPIRY_MS,
        },
      }),
    );
    const sandbox = await openSandbox(t, {
      subject: SUBJECT,
      credential: { kind: CredentialSourceKind.AuthFile, path },
      configuration: EVAL_CONFIGURATION,
    });
    const credentials = await sandbox.call(llmOperations.list, {
      params: {},
      query: {},
      body: null,
    });
    const created = credentials.items.find(
      (item) => item.name === NATIVE_CREDENTIAL,
    );
    assert.equal(created?.platform, ANTHROPIC_SUBSCRIPTION_PLATFORM);
    const enablement = await sandbox.call(agentOperations["enablement.get"], {
      params: { agent_name: SUBJECT },
      query: {},
      body: null,
    });
    assert.deepEqual(
      enablement.agent_providers.map((item) => item.provider),
      [ANTHROPIC_SUBSCRIPTION_PLATFORM],
    );
    const session = await sandbox.call(workbenchOperations["session.create"], {
      params: {},
      query: {},
      body: { agent_name: SUBJECT, ...sandbox.configuration },
    });
    assert.ok(session.id);
  },
);

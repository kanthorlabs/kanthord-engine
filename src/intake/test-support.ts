import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  OperationResultType,
  type ClientOptions,
  type OperationResult,
} from "../kernel/operation.ts";
import { GitHubPlatform } from "../repository/github.ts";
import { S3Platform } from "../storage/index.ts";
import {
  Consumer,
  type ConsumerValue,
  type IntakeConsumers,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

const CLOSED_LOCAL_PORT = "http://127.0.0.1:9";
const MASTER_KEY_BYTES = 32;

function unexpectedCollaboration(): never {
  throw new Error("Unexpected collaboration.");
}

export interface ConsumerCall {
  consumer: ConsumerValue;
  input: Parameters<IntakeConsumers[keyof IntakeConsumers]>[0];
  options: ClientOptions;
}

export function recordingConsumers(): {
  consumers: IntakeConsumers;
  calls: ConsumerCall[];
} {
  const calls: ConsumerCall[] = [];
  return {
    calls,
    consumers: {
      [Consumer.MissionDeliveryAdmit]: (input, options) => {
        calls.push({ consumer: Consumer.MissionDeliveryAdmit, input, options });
        return Promise.resolve({ type: OperationResultType.Indeterminate });
      },
    },
  };
}

export type ConsumerAnswer = () => Promise<OperationResult<unknown>>;

export function scriptedConsumers(
  calls: ConsumerCall[],
  answers: ConsumerAnswer[],
): IntakeConsumers {
  return {
    [Consumer.MissionDeliveryAdmit]: (input, options) => {
      calls.push({ consumer: Consumer.MissionDeliveryAdmit, input, options });
      const answer = answers.shift();
      assert.ok(answer !== undefined, "Each call has a scripted answer.");
      return answer();
    },
  };
}

export function unusedActionDependencies(): Pick<
  Dependencies,
  | "custody"
  | "github"
  | "gitWriter"
  | "s3"
  | "masterKey"
  | "projects"
  | "consumers"
> {
  return {
    custody: {
      authorizeOperation: unexpectedCollaboration,
      release: unexpectedCollaboration,
      consume: unexpectedCollaboration,
      grantFacts: unexpectedCollaboration,
      custodySuitability: unexpectedCollaboration,
    },
    github: new GitHubPlatform({ baseUrl: CLOSED_LOCAL_PORT }),
    gitWriter: {
      mergePushFresh: unexpectedCollaboration,
      pushSnapshotFresh: unexpectedCollaboration,
      landedOn: unexpectedCollaboration,
    },
    s3: new S3Platform(),
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    projects: { get: unexpectedCollaboration },
    consumers: recordingConsumers().consumers,
  };
}

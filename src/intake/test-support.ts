import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { ulid } from "ulid";
import {
  type Grant,
  type GrantExecution,
  GrantKind,
  type GrantRequest,
  type Material,
  type SshIdentitySubject,
  SshIdentitySubjectKind,
} from "../custody/contract.ts";
import {
  type ClientOptions,
  type OperationResult,
  OperationResultType,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { REPOSITORY_COMPONENT_NAME } from "../repository/contract.ts";
import { GitHubPlatform } from "../repository/github.ts";
import { RepositoryComponent } from "../repository/index.ts";
import { repositoryMigrations } from "../repository/migrations.ts";
import { generateSshKey } from "../repository/ssh-key.ts";
import type { IntakeCustody } from "./action-check.ts";
import { intakeMigrations } from "./migrations.ts";
import { S3Platform } from "../storage/index.ts";
import {
  Consumer,
  type ConsumerValue,
  INTAKE_SERVICE_NAME,
  type IntakeConsumers,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

const CLOSED_LOCAL_PORT = "http://127.0.0.1:9";
const CLOSED_STATE_DIRECTORY = "/nonexistent/kanthord-intake-state";
const MASTER_KEY_BYTES = 32;
const SSH_PLATFORM = "ssh";
const PUBLIC_KEY_FIELDS = 2;
const FIELD_SEPARATOR = " ";

export const SSH_CREDENTIAL = "github-ssh";
export const SSH_HOST = "github.com";

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
  | "stateDirectory"
  | "projects"
  | "consumers"
  | "unresolvedRequests"
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
      changedGateFiles: unexpectedCollaboration,
      sshAccessOf: unexpectedCollaboration,
    },
    s3: new S3Platform(),
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    stateDirectory: CLOSED_STATE_DIRECTORY,
    projects: { get: unexpectedCollaboration },
    consumers: recordingConsumers().consumers,
    unresolvedRequests: unexpectedCollaboration,
  };
}

export function sshStore(t: TestContext): {
  store: Store;
  pin: (host: string) => string;
} {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
    { service: REPOSITORY_COMPONENT_NAME, migrations: repositoryMigrations },
  ]);
  const pin = (host: string) => {
    const public_key = generateSshKey(host)
      .public_key.split(FIELD_SEPARATOR)
      .slice(0, PUBLIC_KEY_FIELDS)
      .join(FIELD_SEPARATOR);
    store.transaction((tx) =>
      tx.database
        .prepare(
          "INSERT INTO repository_host_key (id, host, public_key, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(`host_key_${ulid()}`, host, public_key, Date.now()),
    );
    return `${host} ${public_key}`;
  };
  return { store, pin };
}

export function sshAccessOf(): RepositoryComponent["sshAccessOf"] {
  const repository = new RepositoryComponent({ checkTools: () => {} });
  return (tx, granted, material) =>
    repository.sshAccessOf(tx, granted, material);
}

export class TestMaterial implements Material {
  readonly credential_id: string;
  readonly platform: string;
  #secret: unknown;
  dropped = false;

  constructor(platform: string, secret: unknown) {
    this.credential_id = `credential_${ulid()}`;
    this.platform = platform;
    this.#secret = secret;
  }

  value(): unknown {
    assert.ok(!this.dropped, "A dropped material holds no value.");
    return this.#secret;
  }

  drop(): void {
    this.dropped = true;
    this.#secret = null;
  }
}

export interface SshCustodyScript {
  facts: unknown;
  credential: string | null;
  platform: string;
  project_id: string;
  execution: GrantExecution | null;
  secret: unknown;
  refusal: Error | null;
  sshFacts?: { binding_id: string; address: string };
}

export function sshCustody(script: SshCustodyScript): {
  custody: IntakeCustody;
  requests: GrantRequest[];
  materials: TestMaterial[];
  privateKey: string;
} {
  const requests: GrantRequest[] = [];
  const materials: TestMaterial[] = [];
  const { private_key: privateKey } = generateSshKey(SSH_CREDENTIAL);
  const grantOf = (request: GrantRequest): Grant => {
    if (request.kind === GrantKind.SshIdentity) {
      assert.notEqual(request.subject.kind, SshIdentitySubjectKind.Draft);
      return Object.freeze({
        kind: GrantKind.SshIdentity,
        credential: SSH_CREDENTIAL,
        platform: SSH_PLATFORM,
        project_id: script.project_id,
        execution: request.claim === null ? null : script.execution,
        facts: Object.freeze(
          script.sshFacts ?? {
            binding_id: bindingIdOf(request.subject, script.facts),
            address: addressOf(script.facts),
          },
        ),
      });
    }
    return Object.freeze({
      kind: request.kind,
      credential: script.credential,
      platform: script.platform,
      project_id: script.project_id,
      execution:
        "claim" in request && request.claim !== null ? script.execution : null,
      facts: script.facts,
    }) as Grant;
  };
  const custody: IntakeCustody = {
    authorizeOperation: ((_tx, request: GrantRequest) => {
      requests.push(request);
      return grantOf(request);
    }) as IntakeCustody["authorizeOperation"],
    release: (_tx, grant) => {
      if (grant.kind === GrantKind.SshIdentity) {
        if (script.refusal !== null) throw script.refusal;
        const material = new TestMaterial(SSH_PLATFORM, {
          private_key: privateKey,
        });
        materials.push(material);
        return material;
      }
      if (grant.kind === GrantKind.ServiceMerge && script.refusal !== null)
        throw script.refusal;
      const material = new TestMaterial(script.platform, script.secret);
      materials.push(material);
      return material;
    },
    consume: () => {},
    grantFacts: ((grant: Grant) =>
      Object.freeze({
        project_id: grant.project_id,
        credential: grant.credential,
        facts: grant.facts,
      })) as IntakeCustody["grantFacts"],
    custodySuitability: unexpectedCollaboration,
  };
  return { custody, requests, materials, privateKey };
}

function bindingIdOf(subject: SshIdentitySubject, facts: unknown): string {
  if (subject.kind === SshIdentitySubjectKind.Binding)
    return subject.binding_id;
  const repository = (facts as { repository: { binding_id: string } })
    .repository;
  assert.ok(repository.binding_id.length);
  return repository.binding_id;
}

function addressOf(facts: unknown): string {
  const repository = (facts as { repository: { address: string } }).repository;
  assert.ok(repository.address.length);
  return repository.address;
}

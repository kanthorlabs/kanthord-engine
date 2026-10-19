import assert from "node:assert/strict";
import {
  SshIdentitySubjectKind,
  type Authorized,
  type SshIdentityAuthorization,
  type SshIdentityFacts,
  type SshIdentitySubject,
} from "../custody/contract.ts";
import {
  isHumanIdentity,
  isMachineIdentity,
  isServiceIdentity,
  type CallerIdentity,
} from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { MISSION_SERVICE_NAME } from "../mission/contract.ts";
import {
  BindingKind,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  SSH_CREDENTIAL_PLATFORM,
  repositoryConfigSchema,
  type CustodySuitability,
  type RepositoryBindingIdsOf,
  type RequestEvidenceBindingOf,
} from "./contract.ts";
import {
  hasBindingTombstone,
  kindOf,
  readBindingRevision,
  requireProject,
  type StoredBinding,
} from "./store.ts";

export const SshAuthorizationRefusal = {
  BindingNotFound: "binding_not_found",
  IdentityRefused: "identity_refused",
  NodeMismatch: "node_mismatch",
} as const;
type SshAuthorizationRefusal =
  (typeof SshAuthorizationRefusal)[keyof typeof SshAuthorizationRefusal];

export interface SshAuthorizationDependencies {
  custodySuitability: CustodySuitability;
  repositoryBindingIdsOf: RepositoryBindingIdsOf;
  requestEvidenceBindingOf: RequestEvidenceBindingOf;
}

function refused(reason: SshAuthorizationRefusal): never {
  throw new OperationError(
    HttpStatus.Forbidden,
    ProjectErrorCode.AuthorizationRefused,
    "The facility refuses the operation.",
    { reason },
  );
}

function liveRepositoryBinding(
  tx: Transaction,
  bindingId: string,
): StoredBinding {
  const binding = readBindingRevision(tx, bindingId);
  if (
    !binding ||
    kindOf(binding.resource_identity) !== BindingKind.Repository ||
    hasBindingTombstone(tx, binding)
  )
    refused(SshAuthorizationRefusal.BindingNotFound);
  assert.equal(binding.id, bindingId);
  return binding;
}

function refuseBindingCaller(
  tx: Transaction,
  dependencies: SshAuthorizationDependencies,
  identity: CallerIdentity,
  claim: ExecutionClaim | null,
  binding: StoredBinding,
): void {
  if (isHumanIdentity(identity)) return;
  if (isServiceIdentity(identity) && identity.service === PROJECT_SERVICE_NAME)
    return;
  if (!isMachineIdentity(identity) || claim === null)
    refused(SshAuthorizationRefusal.IdentityRefused);
  if (
    claim.projectId !== binding.project_id ||
    !dependencies
      .repositoryBindingIdsOf(tx, claim.nodeId, claim.pinnedRevision)
      .includes(binding.id)
  )
    refused(SshAuthorizationRefusal.NodeMismatch);
}

function requestEvidenceBinding(
  tx: Transaction,
  dependencies: SshAuthorizationDependencies,
  identity: CallerIdentity,
  claim: ExecutionClaim | null,
  evidenceId: string,
): StoredBinding {
  if (
    !isServiceIdentity(identity) ||
    identity.service !== MISSION_SERVICE_NAME ||
    claim !== null
  )
    refused(SshAuthorizationRefusal.IdentityRefused);
  return liveRepositoryBinding(
    tx,
    dependencies.requestEvidenceBindingOf(tx, identity, evidenceId),
  );
}

function subjectBinding(
  tx: Transaction,
  dependencies: SshAuthorizationDependencies,
  identity: CallerIdentity,
  claim: ExecutionClaim | null,
  subject: Exclude<
    SshIdentitySubject,
    { kind: typeof SshIdentitySubjectKind.Draft }
  >,
): StoredBinding {
  if (subject.kind === SshIdentitySubjectKind.RequestEvidence)
    return requestEvidenceBinding(
      tx,
      dependencies,
      identity,
      claim,
      subject.evidence_id,
    );
  const binding = liveRepositoryBinding(tx, subject.binding_id);
  refuseBindingCaller(tx, dependencies, identity, claim, binding);
  return binding;
}

export function projectSshIdentityAuthorization(
  dependencies: SshAuthorizationDependencies,
): SshIdentityAuthorization {
  return {
    sshIdentity(tx, identity, subject, claim): Authorized<SshIdentityFacts> {
      assert.ok(tx.database.isTransaction);
      if (subject.kind === SshIdentitySubjectKind.Draft) {
        if (!isHumanIdentity(identity))
          refused(SshAuthorizationRefusal.IdentityRefused);
        requireProject(tx, subject.project_id);
        dependencies.custodySuitability(tx, {
          credential: subject.credential,
          platform: SSH_CREDENTIAL_PLATFORM,
        });
        return {
          credential: subject.credential,
          platform: SSH_CREDENTIAL_PLATFORM,
          project_id: subject.project_id,
          facts: { binding_id: null, address: subject.address },
        };
      }
      const binding = subjectBinding(
        tx,
        dependencies,
        identity,
        claim,
        subject,
      );
      const config = repositoryConfigSchema.parse(binding.config);
      return {
        credential: config.ssh_credential,
        platform: SSH_CREDENTIAL_PLATFORM,
        project_id: binding.project_id,
        facts: { binding_id: binding.id, address: config.address },
      };
    },
  };
}

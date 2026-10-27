import assert from "node:assert/strict";
import { join } from "node:path";
import { SshIdentitySubjectKind } from "../custody/contract.ts";
import { isMachineIdentity } from "../kernel/caller.ts";
import { CodedError, OperationError } from "../kernel/errors.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import {
  GATE_DECLARATION_INVALID,
  type GitWriter,
} from "../repository/index.ts";
import { isGitTransportFailure, releaseSshAccess } from "./action-check.ts";
import type { IntakeCustody } from "./action-check.ts";
import { PLATFORM_CALL_DEADLINE_MS } from "./contract.ts";

const INTAKE_STATE_DIRECTORY = "intake";
const REPOSITORIES_DIRECTORY = "repositories";
const BARE_REPOSITORY_SUFFIX = ".git";
const BAD_GATEWAY_STATUS = 502;

export interface GateFilesDependencies {
  store: Store;
  custody: IntakeCustody;
  gitWriter: GitWriter;
  stateDirectory: string;
  runs: Map<string, Promise<unknown>>;
}

export async function readGateFiles(
  dependencies: GateFilesDependencies,
  caller: CallerContext,
  body: { binding_id: string; base_branch: string; commit: string },
): Promise<{ paths: string[] }> {
  const identity = caller.identity;
  const claim = caller.execution;
  assert.ok(identity && isMachineIdentity(identity), "A client calls.");
  assert.ok(claim, "A client call holds a proven execution claim.");
  const { address, access, binding_id } = dependencies.store.transaction((tx) =>
    releaseSshAccess(dependencies, tx, Date.now(), {
      identity,
      claim,
      subject: {
        kind: SshIdentitySubjectKind.Binding,
        binding_id: body.binding_id,
      },
    }),
  );
  assert.equal(binding_id, body.binding_id);
  const directory = join(
    dependencies.stateDirectory,
    INTAKE_STATE_DIRECTORY,
    REPOSITORIES_DIRECTORY,
    body.binding_id + BARE_REPOSITORY_SUFFIX,
  );
  try {
    const paths = await serialized(dependencies.runs, directory, () =>
      dependencies.gitWriter.changedGateFiles(
        {
          address,
          base_branch: body.base_branch,
          commit: body.commit,
          directory,
        },
        caller.context,
        Date.now() + PLATFORM_CALL_DEADLINE_MS,
        access,
      ),
    );
    return caller.commit(() => ({ paths }));
  } catch (error) {
    if (isBadGateway(error))
      throw new OperationError(BAD_GATEWAY_STATUS, error.code, error.message);
    throw error;
  }
}

function isBadGateway(error: unknown): error is CodedError {
  return (
    isGitTransportFailure(error) ||
    (error instanceof CodedError && error.code === GATE_DECLARATION_INVALID)
  );
}

function serialized<T>(
  runs: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = runs.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  runs.set(key, next);
  return next.finally(() => {
    if (runs.get(key) === next) runs.delete(key);
  });
}

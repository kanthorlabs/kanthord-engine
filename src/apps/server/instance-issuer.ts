import { CLIENT_IDENTITY_PREFIX } from "../../kernel/caller.ts";
import {
  deriveClientSecret,
  generateInstanceClientJWT,
  generateWorkerJWT,
} from "../../gateway/auth/jwt.ts";
import type { InstanceIssuer } from "../../worker/contract.ts";
import { derivedCrockford } from "./slot-identity.ts";

const LABEL_PREFIX = "worker/instance-client";

export function instanceClientIdentity(
  masterKey: string,
  instanceId: string,
  projectId: string,
  resourceIdentity: string,
  generation: number,
): string {
  const text = derivedCrockford(
    masterKey,
    [LABEL_PREFIX, instanceId, projectId, resourceIdentity, generation].join(
      "/",
    ),
  );
  return `${CLIENT_IDENTITY_PREFIX}_${text}`;
}

export function instanceIssuer(
  masterKey: string,
  authVersion: number,
): InstanceIssuer {
  return {
    workerToken: (instance) =>
      generateWorkerJWT(masterKey, authVersion, instance),
    clientToken: (client) =>
      generateInstanceClientJWT(masterKey, authVersion, client),
    clientIdentity: (instanceId, projectId, resourceIdentity, generation) =>
      instanceClientIdentity(
        masterKey,
        instanceId,
        projectId,
        resourceIdentity,
        generation,
      ),
    clientSecret: (clientId) =>
      deriveClientSecret(masterKey, authVersion, clientId),
  };
}

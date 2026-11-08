import {
  type CallerIdentity,
  isHumanIdentity,
  isMachineIdentity,
  isWorkerIdentity,
} from "../kernel/caller.ts";
import { HttpStatus, MediaType } from "../kernel/http.ts";
import { isObject, isString } from "../kernel/values.ts";

export const CANCELLED_CODE = "gateway.invocation.cancelled";
export const CLIENT_CLOSED_STATUS = 499;
const FIRST_FAILURE_STATUS = HttpStatus.BadRequest;

export interface RequestOutcome {
  caller?: string;
  clientAborted: boolean;
}

export function callerName(identity: CallerIdentity): string {
  if (isHumanIdentity(identity)) return identity.name;
  if (isMachineIdentity(identity)) return identity.clientId;
  if (isWorkerIdentity(identity)) return identity.instanceId;
  return identity.service;
}

export function failureCodeOf(
  status: number,
  body: unknown,
): string | undefined {
  if (status < FIRST_FAILURE_STATUS || !isObject(body)) return undefined;
  const error = (body as { error?: unknown }).error;
  if (!isObject(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return isString(code) ? code : undefined;
}

export async function failureCodeOfResponse(
  response: Response,
): Promise<string | undefined> {
  if (
    response.status < FIRST_FAILURE_STATUS ||
    !response.headers.get("content-type")?.startsWith(MediaType.JSON)
  )
    return undefined;
  return failureCodeOf(response.status, await response.clone().json());
}

export function finishedFields(
  outcome: RequestOutcome,
  status: number,
  code: string | undefined,
  latency: number,
) {
  const clientCancelled = outcome.clientAborted && code === CANCELLED_CODE;
  return {
    status: clientCancelled ? CLIENT_CLOSED_STATUS : status,
    ...(clientCancelled ? { wire_status: status } : {}),
    ...(code === undefined ? {} : { code }),
    ...(outcome.caller === undefined ? {} : { caller: outcome.caller }),
    latency,
  };
}

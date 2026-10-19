import { abortSignal, type Context } from "./context.ts";
import {
  ResourceFailureReason,
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "./health.ts";
import { HttpMethod, HttpStatus } from "./http.ts";

export const AUTHORIZATION_HEADER = "Authorization";

const REASON_MAX_LENGTH = 300;
const EMPTY_LENGTH = 0;
const REDACTED = "[redacted]";
const BEARER_PATTERN = /Bearer\s+\S+/gi;
const JWT_PATTERN = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const TOKEN_PATTERN = /[A-Za-z0-9_\-+/=.]{32,}/g;

export function redactReason(
  text: string,
  secrets: readonly string[] = [],
): string {
  let result = text;
  for (const secret of secrets)
    if (secret.length > EMPTY_LENGTH)
      result = result.split(secret).join(REDACTED);
  return result
    .replace(BEARER_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(TOKEN_PATTERN, REDACTED)
    .slice(0, REASON_MAX_LENGTH);
}

export function headerSecrets(
  headers: Record<string, string>,
): readonly string[] {
  return Object.values(headers).flatMap((value) => [
    value,
    ...value.split(/\s+/),
  ]);
}

export function thrownReason(
  error: unknown,
  secrets: readonly string[],
): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return redactReason(`${name}: ${message}`, secrets);
}

const FAILURE_REASON_OF_STATUS: Readonly<
  Partial<Record<number, ResourceFailureReason>>
> = {
  [HttpStatus.Unauthorized]: ResourceFailureReason.Unauthorized,
  [HttpStatus.Forbidden]: ResourceFailureReason.Forbidden,
  [HttpStatus.TooManyRequests]: ResourceFailureReason.RateLimited,
};

export function failureReasonOfStatus(status: number): ResourceFailureReason {
  return (
    FAILURE_REASON_OF_STATUS[status] ?? ResourceFailureReason.InvalidResponse
  );
}

export async function probeHttp(
  url: string,
  headers: Record<string, string>,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    const { signal, dispose } = abortSignal(context);
    try {
      if (signal.aborted) return ResourceStatus.Unknown;
      const response = await globalThis.fetch(url, {
        method: HttpMethod.Get,
        headers,
        signal,
        redirect: "manual",
      });
      await response.body?.cancel();
      if (signal.aborted) return ResourceStatus.Unknown;
      if (response.status === HttpStatus.OK) return ResourceStatus.Healthy;
      observe?.(
        `status=${response.status}`,
        failureReasonOfStatus(response.status),
      );
      if (response.status === HttpStatus.Forbidden)
        return ResourceStatus.Unknown;
      return ResourceStatus.Unhealthy;
    } finally {
      dispose();
    }
  } catch (error) {
    observe?.(
      thrownReason(error, headerSecrets(headers)),
      ResourceFailureReason.Unreachable,
    );
    return ResourceStatus.Unknown;
  }
}

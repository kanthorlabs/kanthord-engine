import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import {
  ResourceFailureReason,
  type ResourceObserver,
  ResourceStatus,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AUTHORIZATION_HEADER,
  failureReasonOfStatus,
  headerSecrets,
  thrownFailureReason,
  thrownReason,
} from "../kernel/probe.ts";

export const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";

const authTestAnswerSchema = z.looseObject({ ok: z.boolean() });

export async function probeSlackToken(
  token: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  const headers = { [AUTHORIZATION_HEADER]: `Bearer ${token}` };
  try {
    const { signal } = context;
    if (signal.aborted) return ResourceStatus.Unknown;
    const response = await globalThis.fetch(SLACK_AUTH_TEST_URL, {
      method: HttpMethod.Post,
      headers,
      signal,
      redirect: "manual",
    });
    if (response.status !== HttpStatus.OK) {
      await response.body?.cancel();
      observe?.(
        `status=${response.status}`,
        failureReasonOfStatus(response.status),
      );
      return response.status === HttpStatus.Forbidden
        ? ResourceStatus.Unknown
        : ResourceStatus.Unhealthy;
    }
    const answer = authTestAnswerSchema.parse(await response.json());
    if (signal.aborted) return ResourceStatus.Unknown;
    if (answer.ok) return ResourceStatus.Healthy;
    observe?.("ok=false", ResourceFailureReason.Unauthorized);
    return ResourceStatus.Unhealthy;
  } catch (error) {
    observe?.(
      thrownReason(error, headerSecrets(headers)),
      thrownFailureReason(context),
    );
    return ResourceStatus.Unknown;
  }
}

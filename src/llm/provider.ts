import type { Context } from "../kernel/context.ts";
import {
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { Connection, type ProviderCheckAnswer } from "./contract.ts";

export interface LlmProvider {
  check(
    secret: unknown,
    metadata: unknown,
    context: Context,
    observe?: ResourceObserver,
  ): Promise<ProviderCheckAnswer>;
}

export const HEALTH_OF_CONNECTION: Readonly<
  Record<Connection, ResourceStatusValue>
> = {
  [Connection.Ok]: ResourceStatus.Healthy,
  [Connection.Unauthorized]: ResourceStatus.Unhealthy,
  [Connection.Unreachable]: ResourceStatus.Unknown,
  [Connection.InvalidResponse]: ResourceStatus.Unknown,
};

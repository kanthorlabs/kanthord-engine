import type { Context } from "./context.ts";
import { asError } from "./errors.ts";

export const HealthStatus = { Healthy: 200, Unavailable: 503 } as const;
const EMPTY_COMPONENT_COUNT = 0;

/** Owned component name to integer status: 200 healthy, 503 unavailable. */
export type Healthcheck = Record<string, number>;

export function healthy(components: Healthcheck): boolean {
  const codes = Object.values(components);
  return (
    codes.length > EMPTY_COMPONENT_COUNT &&
    codes.every((code) => code === HealthStatus.Healthy)
  );
}

/** start acquires resources; stop releases them; run joins the service lifetime. */
export interface Service {
  start(): Promise<Error | null>;
  stop(): Promise<Error | null>;
  run(context?: Context): Promise<Error | null>;
  healthcheck(): Promise<Healthcheck>;
}

/** Lifecycle failures are values; preserve the original Error for the caller. */
export async function lifecycle(
  work: () => Promise<void>,
): Promise<Error | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return asError(error);
  }
}

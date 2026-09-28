import { StoreName, type OperationRegistry } from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import {
  Authentication,
  type AuthenticationLookups,
} from "./authentication.ts";
import { Idempotency } from "./idempotency.ts";
import { Invocation } from "./invocation.ts";
export { GatewayService, type GatewayDependencies } from "./service.ts";
export { gatewayMigrations } from "./migrations.ts";
export { collectInventories } from "./health-report.ts";
export { gatewayConfigSchema, type GatewayConfig } from "./config.ts";
export { directClient } from "./direct-client.ts";
export { GATEWAY_STARTED_MESSAGE } from "./constants.ts";
export function createInvocation(options: {
  registry: OperationRegistry;
  stores: Record<StoreName, Store>;
  idempotencyTtl?: number;
  masterKey: string;
  tokenLifetime: number;
  lookups?: AuthenticationLookups;
}): Invocation {
  const authentication = new Authentication(options.masterKey, options.lookups);
  const idempotency = new Idempotency(options.idempotencyTtl);
  return new Invocation(
    options.registry,
    authentication,
    idempotency,
    options.stores,
  );
}

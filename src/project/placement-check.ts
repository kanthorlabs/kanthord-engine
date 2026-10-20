import { Diagnostic } from "../kernel/errors.ts";
import type { Store } from "../kernel/store.ts";
import { BindingKind, workerConfigSchema } from "./contract.ts";
import { kindOf, readCurrentBindings } from "./store.ts";

export const BINDING_PLACEMENT_MISSING_CODE =
  "system.database.binding_placement_missing";
const BINDING_PLACEMENT_MISSING_MESSAGE =
  "a hosted worker binding has no placement; follow the reset procedure of docs/reference/upgrade.md: stop the server, delete kanthord.db, tracking.db and their -wal and -shm files in the data directory, and start again";

export function enforceBindingPlacements(
  store: Store,
  isHostedWorker: (workerName: string) => boolean,
): void {
  store.transaction((tx) => {
    for (const binding of readCurrentBindings(tx)) {
      if (kindOf(binding.resource_identity) !== BindingKind.Worker) continue;
      const config = workerConfigSchema.parse(binding.config);
      if (!isHostedWorker(config.worker) || config.placement !== undefined)
        continue;
      throw new Diagnostic(
        BINDING_PLACEMENT_MISSING_CODE,
        BINDING_PLACEMENT_MISSING_MESSAGE,
        {
          fields: [
            ["path", store.path],
            ["project_id", binding.project_id],
            ["binding", binding.name],
          ],
        },
      );
    }
  });
}

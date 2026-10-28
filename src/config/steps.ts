import type { Document } from "yaml";
import { Diagnostic } from "../kernel/errors.ts";

export const ConfigChangeKind = {
  Rename: "rename",
  Removal: "removal",
} as const;

export type ConfigChange =
  | {
      readonly kind: typeof ConfigChangeKind.Rename;
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: typeof ConfigChangeKind.Removal; readonly key: string };

export type ConfigStep = (document: Document) => readonly ConfigChange[];

export const CONFIG_VERSION_FIELD = "version";
export const ABSENT_CONFIG_VERSION = 1;

export function renameKey(
  document: Document,
  from: string,
  to: string,
): readonly ConfigChange[] {
  const source = from.split(".");
  const target = to.split(".");
  if (!document.hasIn(source)) return [];
  if (document.hasIn(target))
    throw new Diagnostic(
      "system.config.rename_conflict",
      "the old key and the new key are both present; remove one of them",
      {
        fields: [
          ["old_key", from],
          ["new_key", to],
        ],
      },
    );
  document.setIn(target, document.getIn(source));
  document.deleteIn(source);
  return [{ kind: ConfigChangeKind.Rename, from, to }];
}

export function removeKey(
  document: Document,
  key: string,
): readonly ConfigChange[] {
  const path = key.split(".");
  if (!document.hasIn(path)) return [];
  document.deleteIn(path);
  return [{ kind: ConfigChangeKind.Removal, key }];
}

export const CONFIG_STEPS: readonly ConfigStep[] = [
  (document) => [
    ...renameKey(
      document,
      "mission.consecutive_loss_limit",
      "mission.consecutive_failure_limit",
    ),
    ...renameKey(document, "gateway.token_version", "gateway.auth.version"),
    ...renameKey(
      document,
      "gateway.token_lifetime",
      "gateway.auth.token_lifetime",
    ),
  ],
  (document) => [
    ...removeKey(document, "agent.prompt.system_file"),
    ...removeKey(document, "agent.prompt.host_file"),
  ],
  (document) =>
    renameKey(
      document,
      "worker.server_slot_limit",
      "worker.server_instance_limit",
    ),
];

export const CONFIG_VERSION = ABSENT_CONFIG_VERSION + CONFIG_STEPS.length;

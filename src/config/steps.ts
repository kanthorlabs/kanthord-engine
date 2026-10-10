import type { Document } from "yaml";
import { Diagnostic } from "../kernel/errors.ts";

export interface ConfigChange {
  readonly from: string;
  readonly to: string;
}

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
      `${from} and ${to} are both present. Remove one of them.`,
    );
  document.setIn(target, document.getIn(source));
  document.deleteIn(source);
  return [{ from, to }];
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
];

export const CONFIG_VERSION = ABSENT_CONFIG_VERSION + CONFIG_STEPS.length;

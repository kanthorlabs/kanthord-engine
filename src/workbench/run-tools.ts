import { AuthorKind, WORKBENCH_REQUEST_OWNER_ACT_TOOL } from "./contract.ts";
import { WORKBENCH_ACTION_TOOL_NAME } from "./actions.ts";
import { EVIDENCE_READ_TOOL } from "./evidence.ts";

export const RunKind = { Owner: "owner", Guest: "guest" } as const;
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

export interface SessionTools {
  readonly open: readonly string[];
  readonly workbench: readonly string[];
}

export const RUN_KIND_TOOLS: Readonly<Record<RunKind, readonly string[]>> = {
  [RunKind.Owner]: [WORKBENCH_ACTION_TOOL_NAME, EVIDENCE_READ_TOOL],
  [RunKind.Guest]: [WORKBENCH_REQUEST_OWNER_ACT_TOOL, EVIDENCE_READ_TOOL],
};

export function runKindOf(origin: AuthorKind): RunKind {
  return origin === AuthorKind.Guest ? RunKind.Guest : RunKind.Owner;
}

export function toolsOfRunKind(
  tools: SessionTools,
  kind: RunKind,
): readonly string[] {
  const listed = RUN_KIND_TOOLS[kind];
  return [
    ...tools.open,
    ...tools.workbench.filter((name) => listed.includes(name)),
  ];
}

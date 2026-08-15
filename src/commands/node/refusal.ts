export const nodeWriteRefusalCodes = [
  "project-not-found",
  "node-not-found",
  "kind-mismatch",
  "stale-revision",
  "plan-invalid",
  "illegal-transition",
  "binding-in-use",
] as const;

export type NodeWriteRefusalCode = (typeof nodeWriteRefusalCodes)[number];

export class NodeWriteError extends Error {
  readonly refusal: NodeWriteRefusalCode;
  readonly details: unknown;

  constructor(
    refusal: NodeWriteRefusalCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "NodeWriteError";
    this.refusal = refusal;
    this.details = details;
  }
}

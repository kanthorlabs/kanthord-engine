import { z } from "zod";
import type { EnvironmentSource } from "../kernel/devcontainer.ts";
import type {
  Attributes,
  ServerTrace,
  SpanStatus,
} from "../tracking/contract.ts";
import type { EnvironmentTarget } from "./contract.ts";

export const EnvironmentSpan = {
  Root: "project.environment",
  Build: "environment.build",
  Setup: "environment.setup",
  Proof: "environment.proof",
} as const;
export const environmentSpanSchema = z.enum(EnvironmentSpan);
export type EnvironmentSpan = z.infer<typeof environmentSpanSchema>;

export type EnvironmentStepSpan = Exclude<
  EnvironmentSpan,
  typeof EnvironmentSpan.Root
>;

export const EnvironmentAttribute = {
  ProjectId: "project.id",
  BindingName: "project.binding.name",
  Target: "environment.target",
  Source: "environment.source",
  Digest: "environment.digest",
  ErrorType: "error.type",
} as const;

const START_RECORD = "start";
const END_RECORD = "end";

export interface EnvironmentContribution {
  record_id: string;
  span_id: string;
  parent_span_id: string | null;
  operation: string;
  start_time?: number;
  end_time?: number;
  status?: SpanStatus;
  attributes?: Attributes;
}

export interface EnvironmentTelemetry {
  span(trace: ServerTrace, contribution: EnvironmentContribution): void;
}

export interface EnvironmentRun {
  binding_name: string;
  target: EnvironmentTarget;
  source: EnvironmentSource;
  digest: string;
}

export interface EnvironmentEnd {
  end_time: number;
  status: SpanStatus;
  error_type: string | null;
}

export interface EnvironmentStep extends EnvironmentEnd {
  span_id: string;
  operation: EnvironmentStepSpan;
  start_time: number;
}

function errorAttributes(errorType: string | null): Attributes {
  return errorType === null
    ? {}
    : { [EnvironmentAttribute.ErrorType]: errorType };
}

export function environmentRootStart(
  trace: ServerTrace,
  run: EnvironmentRun,
): EnvironmentContribution {
  return {
    record_id: `${trace.root_span_id}:${START_RECORD}`,
    span_id: trace.root_span_id,
    parent_span_id: null,
    operation: EnvironmentSpan.Root,
    start_time: trace.created_at,
    attributes: {
      [EnvironmentAttribute.ProjectId]: trace.project_id,
      [EnvironmentAttribute.BindingName]: run.binding_name,
      [EnvironmentAttribute.Target]: run.target,
      [EnvironmentAttribute.Source]: run.source,
      [EnvironmentAttribute.Digest]: run.digest,
    },
  };
}

export function environmentRootEnd(
  trace: ServerTrace,
  end: EnvironmentEnd,
): EnvironmentContribution {
  return {
    record_id: `${trace.root_span_id}:${END_RECORD}`,
    span_id: trace.root_span_id,
    parent_span_id: null,
    operation: EnvironmentSpan.Root,
    end_time: end.end_time,
    status: end.status,
    attributes: errorAttributes(end.error_type),
  };
}

export function environmentStepSpan(
  trace: ServerTrace,
  step: EnvironmentStep,
): EnvironmentContribution {
  return {
    record_id: `${step.span_id}:${END_RECORD}`,
    span_id: step.span_id,
    parent_span_id: trace.root_span_id,
    operation: step.operation,
    start_time: step.start_time,
    end_time: step.end_time,
    status: step.status,
    attributes: errorAttributes(step.error_type),
  };
}

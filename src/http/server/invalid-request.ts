import type { ZodError, ZodIssue } from "zod";

import { HttpError, httpError } from "../contract/errors.ts";
import { compareBytewise } from "./bytewise.ts";

export const requestRefusals = [
  "body-schema",
  "query-schema",
  "path-parameter",
] as const;
export type RequestRefusal = (typeof requestRefusals)[number];

type RequestIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

function renderPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

function issuesOf(issue: ZodIssue): readonly RequestIssue[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: renderPath([...issue.path, key]),
      code: issue.code,
      message: issue.message,
    }));
  }
  return [
    { path: renderPath(issue.path), code: issue.code, message: issue.message },
  ];
}

function order(left: RequestIssue, right: RequestIssue): number {
  const byPath = compareBytewise(left.path, right.path);
  if (byPath !== 0) {
    return byPath;
  }
  const byCode = compareBytewise(left.code, right.code);
  if (byCode !== 0) {
    return byCode;
  }
  return compareBytewise(left.message, right.message);
}

export function requestIssues(error: ZodError): readonly RequestIssue[] {
  return error.issues.flatMap(issuesOf).sort(order);
}

export function invalidRequest(
  refusal: RequestRefusal,
  message: string,
  error: ZodError,
): HttpError {
  return httpError("invalid-request", message, {
    refusal,
    issues: requestIssues(error),
  });
}

export function invalidPathParameter(
  message: string,
  parameter: string,
): HttpError {
  return httpError("invalid-request", message, {
    refusal: "path-parameter",
    issues: [{ path: parameter, code: "path_parameter_invalid", message }],
  });
}

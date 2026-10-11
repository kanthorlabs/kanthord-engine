import { z } from "zod";
import { Diagnostic } from "../../../kernel/errors.ts";
import { CouncilErrorCode } from "./contract.ts";

const JSON_FENCE = /```json[^\n]*\n([\s\S]*?)\n```/g;
const FENCE_BODY = 1;

export function parseAnswer<S extends z.ZodType>(
  text: string,
  schema: S,
  step: string,
): z.infer<S> {
  const last = [...text.matchAll(JSON_FENCE)].at(-1);
  const source = last ? last[FENCE_BODY]! : text.trim();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Diagnostic(
      CouncilErrorCode.AnswerInvalid,
      `${step}: the answer holds no JSON value.`,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Diagnostic(
      CouncilErrorCode.AnswerInvalid,
      `${step}: ${z.prettifyError(result.error)}`,
    );
  return result.data;
}

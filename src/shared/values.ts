/** Names for JavaScript's typeof results, not application discriminants. */
export const ValueType = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Object: "object",
  Function: "function",
} as const;

// TypeScript does not narrow typeof comparisons against named constants.
export function isString(value: unknown): value is string {
  return typeof value === ValueType.String;
}

export function isNumber(value: unknown): value is number {
  return typeof value === ValueType.Number;
}

export function isObject(value: unknown): value is object {
  return value !== null && typeof value === ValueType.Object;
}

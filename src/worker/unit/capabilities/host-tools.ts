import { Diagnostic } from "../../../kernel/errors.ts";
import type { HostTools } from "../../contract.ts";

export type SessionHostTools = (workspace: string) => HostTools;

export async function asToolError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Diagnostic)
      throw new Error(`${error.code}: ${error.message}`, { cause: error });
    throw error;
  }
}

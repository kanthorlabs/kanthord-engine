import { z } from "zod";

export const epochMillis = z.int();
export const bytes = z.instanceof(Uint8Array);
export const jsonText = z.string();
export const objectId = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);

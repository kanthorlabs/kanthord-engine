import { z } from "zod";

export const TAG_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const TAG_MAX_BYTES = 64;

export const tagSchema = z.string().max(TAG_MAX_BYTES).regex(TAG_PATTERN);

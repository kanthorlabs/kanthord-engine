import { z } from "zod";

export const TRAIT_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const TRAIT_KEY_MAX_BYTES = 64;

export const traitKeySchema = z
  .string()
  .max(TRAIT_KEY_MAX_BYTES)
  .regex(TRAIT_KEY_PATTERN);

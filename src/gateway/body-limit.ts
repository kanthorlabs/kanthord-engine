import { AccessPolicy, type Operation } from "../kernel/operation.ts";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const AUTH_PATH_PREFIX = "/api/auth/";
const AUTH_BODY_LIMIT = 40 * KIBIBYTE;
const DELIVERY_BODY_LIMIT = 50 * MEBIBYTE;
const DEFAULT_BODY_LIMIT = 10 * MEBIBYTE;

export function bodyLimitOf(operation: Operation): number {
  return (
    operation.maxBodyBytes ??
    (operation.path.startsWith(AUTH_PATH_PREFIX)
      ? AUTH_BODY_LIMIT
      : operation.access === AccessPolicy.Delivery
        ? DELIVERY_BODY_LIMIT
        : DEFAULT_BODY_LIMIT)
  );
}

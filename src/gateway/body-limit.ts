import { AccessPolicy, type Operation } from "../kernel/operation.ts";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const AUTH_PATH_PREFIX = "/api/auth/";
const AUTH_BODY_KIBIBYTES = 40;
const DELIVERY_BODY_MEBIBYTES = 50;
const DEFAULT_BODY_MEBIBYTES = 10;
const AUTH_BODY_LIMIT = AUTH_BODY_KIBIBYTES * KIBIBYTE;
const DELIVERY_BODY_LIMIT = DELIVERY_BODY_MEBIBYTES * MEBIBYTE;
const DEFAULT_BODY_LIMIT = DEFAULT_BODY_MEBIBYTES * MEBIBYTE;

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

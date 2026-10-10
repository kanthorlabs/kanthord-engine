import { isIP } from "node:net";
import { isString, isNumber } from "../kernel/values.ts";
import { ROOT_BASE_PATH, BASE_PATH_FORMAT } from "./base-path.ts";
const NO_LIFETIME = 0;
export interface GatewayConfig {
  bind: string;
  port: number;
  allowed_hosts: string[];
  allowed_origins: string[];
  base_path: string;
  token_lifetime: number;
  token_version: number;
  idempotency_ttl: number;
}
const strings = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !isString(entry) || !entry.length)
  )
    throw new Error("expected an array of nonempty strings");
};
export const gatewayConfigSchema = {
  bind: {
    doc: "Listener IP address.",
    default: "127.0.0.1",
    format(value: unknown) {
      if (!isString(value) || !isIP(value))
        throw new Error("expected an IP address");
    },
  },
  port: { doc: "HTTP listener port.", format: "port", default: 31415 },
  allowed_hosts: {
    doc: "Accepted Host headers, including port.",
    format: strings,
    default: ["127.0.0.1:31415", "localhost:31415"],
  },
  allowed_origins: {
    doc: "Allowed CORS origins.",
    format: strings,
    default: ["http://127.0.0.1:27182", "http://localhost:27182"],
  },
  base_path: {
    doc: "Path prefix that serves the whole HTTP surface.",
    default: ROOT_BASE_PATH,
    format(value: unknown) {
      if (
        !isString(value) ||
        (value !== ROOT_BASE_PATH && !BASE_PATH_FORMAT.test(value))
      )
        throw new Error("expected / or a path without a trailing slash");
    },
  },
  token_lifetime: {
    doc: "Token lifetime in seconds.",
    format: "nat",
    default: 31536000,
  },
  token_version: {
    doc: "Signing-key version; an increment invalidates every issued JWT and client secret.",
    format(value: unknown) {
      if (
        !isNumber(value) ||
        !Number.isSafeInteger(value) ||
        value <= NO_LIFETIME
      )
        throw new Error("expected a positive safe integer");
    },
    default: 1,
  },
  idempotency_ttl: {
    doc: "Idempotency record lifetime in seconds.",
    format(value: unknown) {
      if (
        !isNumber(value) ||
        !Number.isSafeInteger(value) ||
        value <= NO_LIFETIME
      )
        throw new Error("expected a positive safe integer");
    },
    default: 86400,
  },
};

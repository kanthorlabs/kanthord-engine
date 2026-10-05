import { isIP } from "node:net";
import { isString, isNumber } from "../kernel/values.ts";
const IPV4_VERSION = 4;
const NO_LIFETIME = 0;
export const IPV6_LOOPBACK = "::1";
export interface GatewayConfig {
  bind: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  tokenLifetime: number;
  idempotencyTtl: number;
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
    doc: "Loopback listener address.",
    default: "127.0.0.1",
    format(value: unknown) {
      if (
        !isString(value) ||
        !(
          (isIP(value) === IPV4_VERSION && value.startsWith("127.")) ||
          value === IPV6_LOOPBACK
        )
      )
        throw new Error("expected a loopback IP address");
    },
  },
  port: { doc: "HTTP listener port.", format: "port", default: 31415 },
  allowedHosts: {
    doc: "Accepted Host headers, including port.",
    format: strings,
    default: ["127.0.0.1:31415", "localhost:31415"],
  },
  allowedOrigins: {
    doc: "Allowed CORS origins.",
    format: strings,
    default: ["http://127.0.0.1:27182", "http://localhost:27182"],
  },
  tokenLifetime: {
    doc: "Token lifetime in seconds.",
    format: "nat",
    default: 31536000,
  },
  idempotencyTtl: {
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

import { isIP } from "node:net";
import { isString } from "../kernel/values.ts";
const IPV4_VERSION = 4;
export const IPV6_LOOPBACK = "::1";
export interface GatewayConfig {
  bind: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  tokenLifetime: number;
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
    default: [],
  },
  tokenLifetime: {
    doc: "Token lifetime in seconds.",
    format: "nat",
    default: 31536000,
  },
};

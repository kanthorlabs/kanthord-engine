import { LogDestination, type LogConfig } from "../kernel/log.ts";
import { isString } from "../kernel/values.ts";
export { LogDestination } from "../kernel/log.ts";
export const MASTER_KEY_BYTES = 32;
export interface GlobalConfig {
  masterKey: string;
  log: LogConfig;
}
export const globalConfigSchema = {
  masterKey: {
    doc: "32-byte master key, encoded as base64.",
    default: null,
    sensitive: true,
    format(value: unknown) {
      if (
        !isString(value) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
        Buffer.from(value, "base64").length !== MASTER_KEY_BYTES ||
        Buffer.from(value, "base64").toString("base64") !== value
      )
        throw new Error("required 32-byte base64 secret");
    },
  },
  log: {
    level: {
      doc: "Operational log level.",
      format: ["trace", "debug", "info", "warn", "error", "fatal"],
      default: "info",
    },
    destination: {
      doc: "Operational log destination.",
      format: Object.values(LogDestination),
      default: LogDestination.StandardError,
    },
  },
};

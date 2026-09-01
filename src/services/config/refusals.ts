import { ConfigError } from "./index.ts";
import {
  explicitAllowedHostsRequired,
  isWildcardBind,
} from "../../domain/host-authority.ts";
import { isLoopbackHost as isLoopback } from "../../domain/loopback.ts";

export { isLoopbackHost as isLoopback } from "../../domain/loopback.ts";

const runMaxLifetimeBelowTtl =
  "runMaxLifetimeMs must be greater than or equal to runTtlMs";

export type StartableInput = Readonly<{
  masterKey: string;
  masterKeyFile: string;
  masterKeyFileMode: number | undefined;
  bind: string;
  token: string;
  tokenFile: string;
  tokenFileMode: number | undefined;
  resolvedToken: string;
  allowedOrigins: readonly string[];
  allowedHosts: readonly string[] | null;
  port: number;
  runTtlMs: number;
  runMaxLifetimeMs: number;
}>;

export function assertStartable(input: StartableInput): void {
  const bothEmpty =
    input.masterKey.length === 0 && input.masterKeyFile.length === 0;
  if (bothEmpty) {
    throw new ConfigError(
      "config-refused",
      "no master key configured; set masterKey or masterKeyFile",
    );
  }

  const bothNonEmpty =
    input.masterKey.length > 0 && input.masterKeyFile.length > 0;
  if (bothNonEmpty) {
    throw new ConfigError(
      "config-refused",
      "masterKey and masterKeyFile are both set; configure exactly one",
    );
  }

  if (
    input.masterKeyFile.length > 0 &&
    input.masterKeyFileMode !== undefined &&
    (input.masterKeyFileMode & 0o777) !== 0o600
  ) {
    const octal = (input.masterKeyFileMode & 0o777)
      .toString(8)
      .padStart(3, "0");
    throw new ConfigError(
      "config-refused",
      `masterKeyFile must have mode 0600; found 0${octal}`,
    );
  }

  if (input.token.length > 0 && input.tokenFile.length > 0) {
    throw new ConfigError(
      "config-refused",
      "http.token and http.tokenFile are both set; configure exactly one",
    );
  }

  if (
    input.tokenFile.length > 0 &&
    input.tokenFileMode !== undefined &&
    (input.tokenFileMode & 0o777) !== 0o600
  ) {
    const octal = (input.tokenFileMode & 0o777).toString(8).padStart(3, "0");
    throw new ConfigError(
      "config-refused",
      `http.tokenFile must have mode 0600; found 0${octal}`,
    );
  }

  const hasToken = input.resolvedToken.length > 0;

  if (!isLoopback(input.bind) && !hasToken) {
    throw new ConfigError(
      "config-refused",
      "a non-loopback bind address requires http.token",
    );
  }

  if (input.allowedOrigins.length > 0 && !hasToken) {
    throw new ConfigError(
      "config-refused",
      "a non-empty http.allowedOrigins requires http.token",
    );
  }

  if (input.allowedHosts === null && isWildcardBind(input.bind)) {
    throw new ConfigError("config-refused", explicitAllowedHostsRequired);
  }

  if (input.allowedHosts === null && input.port === 0) {
    throw new ConfigError("config-refused", explicitAllowedHostsRequired);
  }

  if (input.runMaxLifetimeMs < input.runTtlMs) {
    throw new ConfigError("config-refused", runMaxLifetimeBelowTtl);
  }
}

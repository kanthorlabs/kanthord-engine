import { ConfigError } from "./index.ts";
import { isLoopbackHost as isLoopback } from "../../domain/loopback.ts";

export { isLoopbackHost as isLoopback } from "../../domain/loopback.ts";

export type StartableInput = Readonly<{
  masterKey: string;
  masterKeyFile: string;
  masterKeyFileMode: number | undefined;
  bind: string;
  token: string;
  allowedOrigins: readonly string[];
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

  if (!isLoopback(input.bind) && input.token.length === 0) {
    throw new ConfigError(
      "config-refused",
      "a non-loopback bind address requires http.token",
    );
  }

  if (input.allowedOrigins.length > 0 && input.token.length === 0) {
    throw new ConfigError(
      "config-refused",
      "a non-empty http.allowedOrigins requires http.token",
    );
  }
}

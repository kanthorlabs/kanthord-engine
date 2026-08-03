import { ConfigError } from "./index.ts";

export type StartableInput = Readonly<{
  masterKey: string;
  masterKeyFile: string;
  masterKeyFileMode: number | undefined;
  bind: string;
  token: string;
}>;

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidOctet(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment.length > 1 && segment[0] === "0") return false;
  const n = Number(segment);
  return n >= 0 && n <= 255;
}

export function isLoopback(bind: string): boolean {
  if (bind === "localhost") return true;
  if (bind === "::1") return true;

  const m = IPV4_LOOPBACK.exec(bind);
  if (m === null) return false;
  return isValidOctet(m[1]!) && isValidOctet(m[2]!) && isValidOctet(m[3]!);
}

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
}

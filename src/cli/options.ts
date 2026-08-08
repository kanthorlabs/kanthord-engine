import fs from "node:fs";

import type { Command } from "commander";

import { isLoopbackUrl } from "../domain/loopback.ts";

export type ClientOptions = Readonly<{
  baseUrl: string | undefined;
  token: string | undefined;
}>;

export type CliErrorCode =
  | "db-remote-base-url"
  | "cli-base-url-missing"
  | "cli-token-conflict"
  | "cli-token-file-mode"
  | "cli-token-file-missing";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export type ResolveInput = Readonly<{
  program: Command;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function registerClientOptions(program: Command): void {
  program
    .option("--base-url <url>", "daemon base url")
    .option("--token <token>", "bearer token for the daemon")
    .option(
      "--api-token-file <path>",
      "file containing the bearer token for the daemon",
    );
}

function trimSingleTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

export function resolveClientOptions(input: ResolveInput): ClientOptions {
  const opts = input.program.opts() as Readonly<{
    baseUrl?: string;
    token?: string;
    apiTokenFile?: string;
  }>;
  const baseUrl = opts.baseUrl ?? input.env.KANTHORD_BASE_URL;
  const token = opts.token ?? input.env.KANTHORD_TOKEN;
  const tokenFile = opts.apiTokenFile ?? input.env.KANTHORD_API_TOKEN_FILE;

  let tokenFromFile: string | undefined;
  if (tokenFile !== undefined && tokenFile.length > 0) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(tokenFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError(
          "cli-token-file-missing",
          `--api-token-file ${tokenFile} does not exist`,
        );
      }
      throw error;
    }
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      const octal = mode.toString(8).padStart(3, "0");
      throw new CliError(
        "cli-token-file-mode",
        `--api-token-file must have mode 0600; found 0${octal}`,
      );
    }
    tokenFromFile = trimSingleTrailingNewline(
      fs.readFileSync(tokenFile, "utf-8"),
    );
  }

  if (
    token !== undefined &&
    token.length > 0 &&
    tokenFromFile !== undefined &&
    tokenFromFile.length > 0
  ) {
    throw new CliError(
      "cli-token-conflict",
      "--token and --api-token-file are both set; configure exactly one",
    );
  }

  const resolvedToken = token ?? tokenFromFile;
  return {
    baseUrl:
      baseUrl === undefined || baseUrl.length === 0 ? undefined : baseUrl,
    token:
      resolvedToken === undefined || resolvedToken.length === 0
        ? undefined
        : resolvedToken,
  };
}

export function requireBaseUrl(options: ClientOptions): string {
  if (options.baseUrl !== undefined) {
    return options.baseUrl;
  }
  throw new CliError(
    "cli-base-url-missing",
    "no daemon base url; set --base-url or KANTHORD_BASE_URL",
  );
}

export function requireLoopbackBaseUrl(options: ClientOptions): void {
  if (options.baseUrl === undefined) {
    return;
  }
  if (!isLoopbackUrl(options.baseUrl)) {
    throw new CliError(
      "db-remote-base-url",
      `${options.baseUrl} is not a loopback daemon; db migrate opens the database file on the daemon machine`,
    );
  }
}

export function printRefusal(
  error: CliError,
  stderr: (text: string) => void,
): void {
  stderr(`kanthord: ${error.code}: ${error.message}\n`);
}

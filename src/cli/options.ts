import fs from "node:fs";

import type { Command } from "commander";

import { isLoopbackUrl, LOOPBACK_IPV4 } from "../domain/loopback.ts";

export type ClientOptions = Readonly<{
  baseUrl: string | undefined;
  token: string | undefined;
}>;

export type ClientConfigDefaults = Readonly<{
  bind: string;
  port: number;
  token: string;
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
  loadConfig?: () => ClientConfigDefaults | undefined;
}>;

export function clientBaseUrl(defaults: ClientConfigDefaults): string {
  const host =
    defaults.bind === "0.0.0.0"
      ? LOOPBACK_IPV4
      : defaults.bind === "::"
        ? "[::1]"
        : defaults.bind.startsWith("[") && defaults.bind.endsWith("]")
          ? defaults.bind
          : defaults.bind.includes(":")
            ? `[${defaults.bind}]`
            : defaults.bind;
  return `http://${host}:${defaults.port}`;
}

export function registerClientOptions(program: Command): void {
  program
    .option("--base-url <url>", "daemon base url")
    .option("--token <token>", "bearer token for the daemon")
    .option(
      "--api-token-file <path>",
      "file containing the bearer token for the daemon",
    )
    .addHelpText(
      "after",
      "\nClient environment variables: KANTHORD_BASE_URL, KANTHORD_TOKEN, KANTHORD_API_TOKEN_FILE.\nClient connection precedence: flags > environment > discovered config.\n",
    );
}

function trimSingleTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

export function resolveClientOptions(input: ResolveInput): ClientOptions {
  const opts = input.program.opts() as Readonly<{
    baseUrl?: string;
    token?: string;
    apiTokenFile?: string;
  }>;
  const baseUrl =
    nonEmpty(opts.baseUrl) ?? nonEmpty(input.env.KANTHORD_BASE_URL);
  const token = nonEmpty(opts.token) ?? nonEmpty(input.env.KANTHORD_TOKEN);
  const tokenFile =
    nonEmpty(opts.apiTokenFile) ?? nonEmpty(input.env.KANTHORD_API_TOKEN_FILE);

  let tokenFromFile: string | undefined;
  if (tokenFile !== undefined) {
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
    tokenFromFile = nonEmpty(
      trimSingleTrailingNewline(fs.readFileSync(tokenFile, "utf-8")),
    );
  }

  if (token !== undefined && tokenFromFile !== undefined) {
    throw new CliError(
      "cli-token-conflict",
      "--token and --api-token-file are both set; configure exactly one",
    );
  }

  const resolvedToken = token ?? tokenFromFile;
  const config =
    baseUrl === undefined || resolvedToken === undefined
      ? input.loadConfig?.()
      : undefined;
  const configToken = config === undefined ? undefined : nonEmpty(config.token);

  return {
    baseUrl:
      baseUrl ?? (config === undefined ? undefined : clientBaseUrl(config)),
    token: resolvedToken ?? configToken,
  };
}

export function requireBaseUrl(options: ClientOptions): string {
  if (options.baseUrl !== undefined) {
    return options.baseUrl;
  }
  throw new CliError(
    "cli-base-url-missing",
    "no daemon base url; set --base-url, KANTHORD_BASE_URL or a discovered config",
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

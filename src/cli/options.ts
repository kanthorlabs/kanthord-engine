import type { Command } from "commander";

import { isLoopbackUrl } from "../domain/loopback.ts";

export type ClientOptions = Readonly<{
  baseUrl: string | undefined;
  token: string | undefined;
}>;

export type CliErrorCode = "db-remote-base-url" | "cli-base-url-missing";

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
    .option("--token <token>", "bearer token for the daemon");
}

export function resolveClientOptions(input: ResolveInput): ClientOptions {
  const opts = input.program.opts() as Readonly<{
    baseUrl?: string;
    token?: string;
  }>;
  const baseUrl = opts.baseUrl ?? input.env.KANTHORD_BASE_URL;
  const token = opts.token ?? input.env.KANTHORD_TOKEN;
  return {
    baseUrl:
      baseUrl === undefined || baseUrl.length === 0 ? undefined : baseUrl,
    token: token === undefined || token.length === 0 ? undefined : token,
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

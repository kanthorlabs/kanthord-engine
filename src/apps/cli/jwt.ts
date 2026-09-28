import assert from "node:assert/strict";
import { Command } from "commander";
import { decode } from "hono/jwt";
import { loadConfig } from "../../config/index.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { isNumber, isObject, isString } from "../../kernel/values.ts";
import {
  generateHumanJWT,
  generateMachineJWT,
  KANTHORD_AUTH_USERNAME,
  parseDisplayName,
  parseHumanUsername,
  parseWorkerBinding,
  requireTokenTerminal,
} from "../../gateway/local.ts";
import { resolveClient } from "../../gateway/client.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { configHelp, effectivePath } from "./config-path.ts";

const IAT_CLAIM = "iat";
const EXP_CLAIM = "exp";
const MAX_DATE_SECONDS = 8640000000000;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function claims(token: string): Record<string, unknown> {
  try {
    if (!token.split(".").every((part) => BASE64URL_SEGMENT.test(part)))
      throw new Error("Invalid JWT segments");
    const { header, payload } = decode(token);
    if (
      !isObject(header) ||
      Array.isArray(header) ||
      !isObject(payload) ||
      Array.isArray(payload)
    )
      throw new Error("Invalid JWT object");
    return payload;
  } catch {
    throw new Diagnostic(
      "cli.jwt.inspect.malformed_token",
      "jwt inspect: expected three base64url segments with a JSON object header and payload.",
    );
  }
}

function renderClaims(token: string): string {
  const lines = Object.entries(claims(token)).map(([key, value]) => {
    const text =
      isString(value) || isNumber(value)
        ? String(value)
        : JSON.stringify(value);
    const timestamp =
      (key === IAT_CLAIM || key === EXP_CLAIM) &&
      isNumber(value) &&
      Number.isSafeInteger(value) &&
      Math.abs(value) <= MAX_DATE_SECONDS
        ? ` # ${new Date(value * 1000).toISOString().replace(".000Z", "Z")}`
        : "";
    return `${key}: ${text}${timestamp}`;
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

export function addJWTCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.JWT),
  );
  const jwt = program
    .command(CommandName.JWT)
    .description("Generate or inspect a JWT locally");
  jwt.action(() => jwt.help());
  const generate = jwt
    .command("generate")
    .description(
      "Generate a human or machine JWT locally (use --verbose to show claims)",
    )
    .argument(
      "[username]",
      `Human username (nonblank, 1–64 characters; default: ${KANTHORD_AUTH_USERNAME})`,
      parseHumanUsername,
    )
    .option(
      "--name <display>",
      "Display name (nonblank, 1–64 characters; defaults to subject)",
      parseDisplayName,
    )
    .option(
      "--binding <worker binding>",
      "Issue a machine JWT (nonblank binding, 1–128 characters; no username)",
      parseWorkerBinding,
    )
    .option("--config <path>", "YAML server configuration file")
    .action(
      async (
        username: string | undefined,
        options: { name?: string; binding?: string },
        command: Command,
      ) => {
        if (options.binding !== undefined && username !== undefined)
          throw new Diagnostic(
            "cli.jwt.username_with_binding",
            "jwt: a username cannot be combined with --binding.",
          );
        requireTokenTerminal(process.stdout);
        const config = loadConfig(effectivePath(command));
        const { token } =
          options.binding === undefined
            ? await generateHumanJWT(
                config.masterKey,
                config.gateway.tokenLifetime,
                username,
                options.name,
              )
            : await generateMachineJWT(
                config.masterKey,
                config.gateway.tokenLifetime,
                options.binding,
                options.name,
              );
        process.stdout.write(`${token}\n`);
        if (command.optsWithGlobals().verbose)
          process.stdout.write(renderClaims(token));
      },
    );
  configHelp(generate);
  jwt
    .command("inspect")
    .description(
      "Decode claims locally without verification; token: argument, KANTHORD_TOKEN, then cli.yaml",
    )
    .argument("[token]", "JWT (otherwise KANTHORD_TOKEN or cli.yaml token)")
    .action((token: string | undefined) => {
      const resolved = resolveClient({ token }).token;
      if (!resolved?.trim())
        throw new Diagnostic(
          "cli.jwt.inspect.token_required",
          "jwt inspect: supply a token argument, KANTHORD_TOKEN or cli.yaml token.",
        );
      process.stdout.write(renderClaims(resolved));
    });
}

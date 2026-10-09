import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Command } from "commander";
import type { ServerConfig } from "../../config/index.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { writePrivate } from "../../kernel/files.ts";
import { isNumber, isObject, isString } from "../../kernel/values.ts";
import {
  deriveClientSecret,
  generateHumanJWT,
  generateMachineJWT,
  KANTHORD_AUTH_USERNAME,
  parseDisplayName,
  parseHumanUsername,
  parseBindingName,
  parseProjectId,
  requireTokenTerminal,
} from "../../gateway/local.ts";
import {
  clientConfigPath,
  clientSchema,
  resolveClient,
  validateClientEndpoint,
} from "../../gateway/client.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { configHelp, effectivePath } from "./config-path.ts";

const IAT_CLAIM = "iat";
const EXP_CLAIM = "exp";
const MAX_DATE_SECONDS = 8640000000000;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

async function claims(token: string): Promise<Record<string, unknown>> {
  const { decode } = await import("hono/jwt");
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

async function renderClaims(token: string): Promise<string> {
  const lines = Object.entries(await claims(token)).map(([key, value]) => {
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

async function loadServerConfig(path: string): Promise<ServerConfig> {
  const { loadConfig } = await import("../../config/index.ts");
  return loadConfig(path);
}

interface GenerateOptions {
  name?: string;
  binding?: string;
  project?: string;
  output?: string | boolean;
  endpoint?: string;
}

function validateGenerateOptions(
  username: string | undefined,
  options: GenerateOptions,
): void {
  if (options.binding !== undefined && username !== undefined)
    throw new Diagnostic(
      "cli.jwt.username_with_binding",
      "jwt: a username cannot be combined with --binding.",
    );
  if (options.binding !== undefined && options.project === undefined)
    throw new Diagnostic(
      "cli.jwt.binding_without_project",
      "jwt generate: --binding requires --project.",
    );
  if (options.project !== undefined && options.binding === undefined)
    throw new Diagnostic(
      "cli.jwt.project_without_binding",
      "jwt generate: --project requires --binding.",
    );
  if (options.output !== undefined && options.binding !== undefined)
    throw new Diagnostic(
      "cli.jwt.output_with_binding",
      "jwt generate: --output cannot be combined with --binding.",
    );
  if (options.endpoint !== undefined && options.output === undefined)
    throw new Diagnostic(
      "cli.jwt.endpoint_without_output",
      "jwt generate: --endpoint requires --output.",
    );
  if (options.endpoint !== undefined) validateClientEndpoint(options.endpoint);
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
      "--binding <binding name>",
      "Issue a machine JWT (binding name, 1–63 lower-case letters, digits or hyphens; no username)",
      parseBindingName,
    )
    .option(
      "--project <project id>",
      "Project identity of the worker binding",
      parseProjectId,
    )
    .option(
      "--output [path]",
      `Write private client configuration (default: ${clientConfigPath()}); creates an absent file only; readers use only the default path`,
    )
    .option("--endpoint <url>", "Endpoint written to the --output file")
    .option("--config <path>", "YAML server configuration file")
    .action(
      async (
        username: string | undefined,
        options: GenerateOptions,
        command: Command,
      ) => {
        validateGenerateOptions(username, options);
        if (options.output === undefined) requireTokenTerminal(process.stdout);
        const config = await loadServerConfig(effectivePath(command));
        const { token } =
          options.binding === undefined
            ? await generateHumanJWT(
                config.master_key,
                config.gateway.token_lifetime,
                username,
                options.name,
              )
            : await generateMachineJWT(
                config.master_key,
                config.gateway.token_lifetime,
                { projectId: options.project!, bindingName: options.binding },
                options.name,
              );
        if (options.output !== undefined) {
          const path = isString(options.output)
            ? resolve(options.output)
            : clientConfigPath();
          const document = clientSchema.parse({
            ...(options.endpoint === undefined
              ? {}
              : { endpoint: options.endpoint }),
            token,
          });
          const { stringify } = await import("yaml");
          writePrivate(path, stringify(document));
          process.stdout.write(`Created ${path}\n`);
        } else if (options.binding === undefined)
          process.stdout.write(`${token}\n`);
        else {
          const { decode } = await import("hono/jwt");
          const { sub } = decode(token).payload;
          assert.ok(isString(sub));
          const clientSecret = deriveClientSecret(config.master_key, sub);
          process.stdout.write(
            `token: ${token}\nclient_secret: ${clientSecret}\n`,
          );
        }
        if (command.optsWithGlobals().verbose)
          process.stdout.write(await renderClaims(token));
      },
    );
  configHelp(generate);
  jwt
    .command("inspect")
    .description(
      "Decode claims locally without verification; token: argument, KANTHORD_TOKEN, then cli.yaml",
    )
    .argument("[token]", "JWT (otherwise KANTHORD_TOKEN or cli.yaml token)")
    .action(async (token: string | undefined) => {
      const resolved = resolveClient({ token }).token;
      if (!resolved?.trim())
        throw new Diagnostic(
          "cli.jwt.inspect.token_required",
          "jwt inspect: supply a token argument, KANTHORD_TOKEN or cli.yaml token.",
        );
      process.stdout.write(await renderClaims(resolved));
    });
}

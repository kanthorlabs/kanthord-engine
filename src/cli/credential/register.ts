import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import type { ConfirmDependencies } from "../confirm.ts";
import { providerRegisterResponse } from "../../http/contract/credential.ts";
import { credentialCommand } from "./index.ts";

export type RegisterCredentialInput = Readonly<{
  program: Command;
  client: DaemonClient;
  env: Readonly<Record<string, string | undefined>>;
  confirm: ConfirmDependencies;
  readFile: (path: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type CredentialOptions = Readonly<{
  name?: string;
  kind?: string;
  transport?: string;
  forge?: string;
  username?: string;
  tokenFile?: string;
  privateKeyFile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyFile?: string;
}>;

function optionFlag(name: string): string {
  return `--${name}`;
}

function trimSingleTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

export function registerCredentialRegister(
  input: RegisterCredentialInput,
): void {
  credentialCommand(input.program)
    .command("register")
    .description("store a credential")
    .option("--name <name>", "credential name")
    .option("--kind <kind>", "credential kind: llm or git")
    .option("--transport <transport>", "git transport: http-basic or ssh")
    .option("--forge <forge>", "git http-basic forge")
    .option("--username <username>", "git http-basic username")
    .option(`${optionFlag("token-file")} <path>`, "file holding the token")
    .option(
      `${optionFlag("private-key-file")} <path>`,
      "file holding the private key",
    )
    .option("--provider <provider>", "llm provider")
    .option("--model <model>", "llm default model")
    .option("--base-url <url>", "llm provider base url")
    .option(`${optionFlag("api-key-file")} <path>`, "file holding the api key")
    .action(async (options: CredentialOptions) => {
      const kind = options.kind;
      if (kind !== "git" && kind !== "llm") {
        input.stderr("kanthord: invalid-request: --kind must be llm or git\n");
        input.fail();
        return;
      }
      if (kind === "git" && options.transport === undefined) {
        input.stderr(
          "kanthord: invalid-request: --transport is required for --kind git\n",
        );
        input.fail();
        return;
      }
      const gitFlags = [
        options.transport,
        options.forge,
        options.username,
        options.tokenFile,
        options.privateKeyFile,
      ];
      const llmFlags = [
        options.provider,
        options.model,
        options.baseUrl,
        options.apiKeyFile,
      ];
      if (kind === "llm" && gitFlags.some((value) => value !== undefined)) {
        input.stderr(
          "kanthord: invalid-request: a git-only option was passed for --kind llm\n",
        );
        input.fail();
        return;
      }
      if (kind === "git" && llmFlags.some((value) => value !== undefined)) {
        input.stderr(
          "kanthord: invalid-request: an llm-only option was passed for --kind git\n",
        );
        input.fail();
        return;
      }
      if (options.name === undefined) {
        input.stderr("kanthord: invalid-request: --name is required\n");
        input.fail();
        return;
      }

      let payload: Readonly<Record<string, unknown>>;
      if (kind === "git") {
        if (options.transport === "http-basic") {
          if (options.tokenFile === undefined) {
            input.stderr(
              `kanthord: invalid-request: ${optionFlag("token-file")} is required for --transport http-basic\n`,
            );
            input.fail();
            return;
          }
          payload = {
            transport: "http-basic",
            forge: options.forge ?? "",
            username: options.username ?? "",
            token: trimSingleTrailingNewline(input.readFile(options.tokenFile)),
          };
        } else if (options.transport === "ssh") {
          if (options.privateKeyFile === undefined) {
            input.stderr(
              `kanthord: invalid-request: ${optionFlag("private-key-file")} is required for --transport ssh\n`,
            );
            input.fail();
            return;
          }
          payload = {
            transport: "ssh",
            privateKey: trimSingleTrailingNewline(
              input.readFile(options.privateKeyFile),
            ),
          };
        } else {
          input.stderr(
            "kanthord: invalid-request: --transport must be http-basic or ssh\n",
          );
          input.fail();
          return;
        }
      } else {
        if (options.apiKeyFile === undefined) {
          input.stderr(
            `kanthord: invalid-request: ${optionFlag("api-key-file")} is required for --kind llm\n`,
          );
          input.fail();
          return;
        }
        payload = {
          provider: options.provider ?? "",
          apiKey: trimSingleTrailingNewline(input.readFile(options.apiKeyFile)),
          defaultModel: options.model ?? "",
          baseUrl: options.baseUrl ?? null,
        };
      }

      const result = await input.client.call("provider.register", {
        name: options.name,
        kind,
        payload,
      });
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.fail();
        return;
      }

      const view = providerRegisterResponse.parse(result.body);
      input.stdout(`kanthord: registered ${view.name} ${view.id}\n`);
      const projection = view.projection as Readonly<{
        transport?: string;
        forge?: string | null;
      }>;
      if (projection.transport !== undefined) {
        input.stdout(`kanthord: transport ${projection.transport}\n`);
      }
      if (projection.forge !== undefined) {
        input.stdout(`kanthord: forge ${projection.forge}\n`);
      }
    });
}

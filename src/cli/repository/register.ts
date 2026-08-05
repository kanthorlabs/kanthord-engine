import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { ConfirmationRequiredError, confirmValue } from "../confirm.ts";
import type { ConfirmDependencies } from "../confirm.ts";
import { providerListResponse } from "../../http/contract/credential.ts";
import {
  repositoryInspectResponse,
  repositoryRegisterResponse,
} from "../../http/contract/repository.ts";
import { repositoryCommand } from "./index.ts";
import { remoteTransport } from "./transport.ts";

export type RegisterRepositoryCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  env: Readonly<Record<string, string | undefined>>;
  confirm: ConfirmDependencies;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type RegisterOptions = Readonly<{
  name?: string;
  url?: string;
  credential?: string;
  upstream?: string;
  landing?: string;
  publishRef?: string;
  hostFingerprint?: string;
  publishOnApproval?: boolean;
}>;

export function registerRepositoryRegister(
  input: RegisterRepositoryCliInput,
): void {
  repositoryCommand(input.program)
    .command("register")
    .description("register a repository")
    .option("--name <name>", "repository name")
    .option("--url <url>", "repository remote url")
    .option("--credential <name>", "credential name to bind")
    .option("--upstream <branch>", "upstream branch")
    .option("--landing <branch>", "landing branch")
    .option("--publish-ref <ref>", "publish ref")
    .option("--host-fingerprint <value>", "confirmed host key fingerprint")
    .option("--no-publish-on-approval", "do not publish on approval")
    .action(async (options: RegisterOptions) => {
      const url = options.url ?? "";
      const transport = remoteTransport(url);
      if (transport === null) {
        input.stderr(
          `kanthord: invalid-request: ${url} names no supported transport\n`,
        );
        input.fail();
        return;
      }

      const listResult = await input.client.call("provider.list", undefined);
      if (!listResult.ok) {
        input.stderr(`kanthord: ${listResult.code}: ${listResult.message}\n`);
        input.fail();
        return;
      }
      const providers = providerListResponse.parse(listResult.body).providers;
      const credentialName = options.credential ?? "";
      const matched = providers.find((item) => item.name === credentialName);
      if (matched === undefined) {
        input.stderr(
          `kanthord: not-found: no credential named ${credentialName}\n`,
        );
        input.fail();
        return;
      }
      if (matched.kind !== "git") {
        input.stderr(
          `kanthord: invalid-request: the credential ${credentialName} is of kind ${matched.kind}\n`,
        );
        input.fail();
        return;
      }

      const inspectResult = await input.client.call("repository.inspect", {
        remoteUrl: url,
        credentialId: matched.id,
      });
      if (!inspectResult.ok) {
        input.stderr(
          `kanthord: ${inspectResult.code}: ${inspectResult.message}\n`,
        );
        input.fail();
        return;
      }
      const inspect = repositoryInspectResponse.parse(inspectResult.body);

      let upstream: string;
      try {
        upstream = await confirmValue(input.confirm, {
          flagName: "--upstream",
          flagValue: options.upstream,
          question: "upstream branch?",
          suggestion: inspect.defaultBranch,
        });
      } catch (error) {
        if (error instanceof ConfirmationRequiredError) {
          input.stderr(`kanthord: confirmation-required: ${error.message}\n`);
          input.fail();
          return;
        }
        throw error;
      }

      let hostFingerprint: string | null = null;
      if (transport === "ssh") {
        try {
          hostFingerprint = await confirmValue(input.confirm, {
            flagName: "--host-fingerprint",
            flagValue: options.hostFingerprint,
            question: "host key fingerprint?",
            suggestion: inspect.hostKey?.fingerprint ?? null,
          });
        } catch (error) {
          if (error instanceof ConfirmationRequiredError) {
            input.stderr(`kanthord: confirmation-required: ${error.message}\n`);
            input.fail();
            return;
          }
          throw error;
        }
      }

      input.stdout(`kanthord: default branch ${inspect.defaultBranch}\n`);
      if (transport === "ssh") {
        const hostKey = inspect.hostKey;
        if (hostKey !== null) {
          input.stdout(
            `kanthord: host key ${hostKey.algorithm} ${hostKey.fingerprint}\n`,
          );
        }
      }
      input.stdout(
        inspect.credential.reachable
          ? "kanthord: credential reachable\n"
          : `kanthord: credential refused: ${inspect.credential.refusal}\n`,
      );

      const landing = options.landing ?? upstream;
      const publishRef = options.publishRef ?? `refs/heads/${upstream}`;

      const registerResult = await input.client.call("repository.register", {
        name: options.name,
        remoteUrl: url,
        credentialId: matched.id,
        upstreamBranch: upstream,
        landingBranch: landing,
        publishRef,
        publishOnApproval: options.publishOnApproval !== false,
        hostFingerprint,
      });
      if (!registerResult.ok) {
        input.stderr(
          `kanthord: ${registerResult.code}: ${registerResult.message}\n`,
        );
        input.fail();
        return;
      }

      const view = repositoryRegisterResponse.parse(registerResult.body);
      input.stdout(`kanthord: registered ${view.name} ${view.id}\n`);
      input.stdout(`kanthord: upstream ${view.upstreamBranch}\n`);
      input.stdout(`kanthord: landing ${view.landingRef} ${view.landingOid}\n`);
      input.stdout(
        `kanthord: tracking ${view.trackingRef} ${view.trackingOid}\n`,
      );
      input.stdout(`kanthord: publish ${view.publishRef}\n`);
      input.stdout(`kanthord: state ${view.state}\n`);
    });
}

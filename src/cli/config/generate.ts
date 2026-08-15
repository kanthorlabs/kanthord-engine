import { join } from "node:path";
import type { Command } from "commander";

import {
  deriveAllowedHosts,
  explicitAllowedHostsRequired,
  isWildcardBind,
} from "../../domain/host-authority.ts";
import { LOOPBACK_IPV4 } from "../../domain/loopback.ts";
import { configCommand } from "./index.ts";

export type RegisterConfigGenerateInput = Readonly<{
  program: Command;
  cwd: string;
  username: string;
  randomBytes: (size: number) => Buffer;
  writeFile: (path: string, content: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

type GenerateOptions = Readonly<{
  home?: string;
  actor?: string;
  bind?: string;
  allowedHost?: string[];
}>;

const collectAllowedHosts = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];

export function registerConfigGenerate(
  input: RegisterConfigGenerateInput,
): void {
  configCommand(input.program)
    .command("generate")
    .description("generate a local daemon configuration")
    .option("--home <path>", "daemon home (default: current directory)")
    .option("--actor <name>", "actor name (default: current username)")
    .option("--bind <address>", "bind address (default: 127.0.0.1)")
    .option(
      "--allowed-host <authority>",
      "allowed Host authority (repeatable)",
      collectAllowedHosts,
      [],
    )
    .action((options: GenerateOptions) => {
      const globalOptions = input.program.opts() as Readonly<{
        home?: string;
      }>;
      const bind = options.bind ?? LOOPBACK_IPV4;
      const allowedHosts = options.allowedHost ?? [];
      if (allowedHosts.length === 0 && isWildcardBind(bind)) {
        input.stderr(
          `kanthord: config-refused: ${explicitAllowedHostsRequired}\n`,
        );
        input.fail();
        return;
      }
      const configPath = join(input.cwd, "kanthord.config.json");
      const config = {
        home: options.home ?? globalOptions.home ?? input.cwd,
        actor: options.actor ?? input.username,
        masterKey: input.randomBytes(32).toString("base64"),
        http: {
          bind,
          port: 31415,
          token: input.randomBytes(8).toString("hex"),
          allowedHosts:
            allowedHosts.length > 0
              ? allowedHosts
              : deriveAllowedHosts({ bind, port: 31415 }),
        },
      };
      input.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      input.stdout(`kanthord: generated ${configPath}\n`);
    });
}

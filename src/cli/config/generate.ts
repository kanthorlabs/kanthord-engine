import { join } from "node:path";
import type { Command } from "commander";

import { LOOPBACK_HOSTNAME, LOOPBACK_IPV4 } from "../../domain/loopback.ts";
import { configCommand } from "./index.ts";

export type RegisterConfigGenerateInput = Readonly<{
  program: Command;
  cwd: string;
  username: string;
  randomBytes: (size: number) => Buffer;
  writeFile: (path: string, content: string) => void;
  stdout: (text: string) => void;
}>;

type GenerateOptions = Readonly<{
  home?: string;
  actor?: string;
}>;

export function registerConfigGenerate(
  input: RegisterConfigGenerateInput,
): void {
  configCommand(input.program)
    .command("generate")
    .description("generate a local daemon configuration")
    .option("--home <path>", "daemon home (default: current directory)")
    .option("--actor <name>", "actor name (default: current username)")
    .action((options: GenerateOptions) => {
      const globalOptions = input.program.opts() as Readonly<{
        home?: string;
      }>;
      const configPath = join(input.cwd, "kanthord.config.json");
      const config = {
        home: options.home ?? globalOptions.home ?? input.cwd,
        actor: options.actor ?? input.username,
        masterKey: input.randomBytes(32).toString("base64"),
        http: {
          bind: "0.0.0.0",
          port: 31415,
          token: input.randomBytes(8).toString("hex"),
          allowedHosts: [
            `${LOOPBACK_IPV4}:31415`,
            `${LOOPBACK_HOSTNAME}:31415`,
          ],
        },
      };
      input.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      input.stdout(`kanthord: generated ${configPath}\n`);
    });
}

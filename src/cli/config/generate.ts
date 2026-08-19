import { resolve } from "node:path";
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
  output?: string;
  allowedHost?: string[];
}>;

// Easter egg: the two pinned ports spell a constant each. 31415 is pi and it
// belongs to the daemon; 27182 is Euler's number and it belongs to the browser.
// Read them as one pair.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:27182",
  "http://127.0.0.1:27182",
];

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
      "--output <directory>",
      "directory for the configuration file (default: current directory)",
    )
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
      const configPath = resolve(
        input.cwd,
        options.output ?? ".",
        "kanthord.config.json",
      );
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
          allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
        },
      };
      input.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      input.stdout(`kanthord: generated ${configPath}\n`);
    });
}

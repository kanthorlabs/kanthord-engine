import { installFatalHandlers } from "./kernel/fatal.ts";
import type { Server } from "./apps/server/index.ts";

let server: Server | undefined;

async function main(): Promise<void> {
  const uninstall = installFatalHandlers(() => server?.logDescriptor() ?? 2);
  try {
    const { runCLI } = await import("./apps/cli/index.ts");
    process.exitCode = await runCLI(process.argv, (value) => {
      server = value;
    });
  } finally {
    uninstall();
  }
}

void main();

import { installFatalHandlers } from "./kernel/fatal.ts";
import type { Server } from "./apps/server/index.ts";

const STDERR_DESCRIPTOR = 2;

let server: Server | undefined;

async function main(): Promise<void> {
  const uninstall = installFatalHandlers(
    () => server?.logDescriptor() ?? STDERR_DESCRIPTOR,
  );
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

import { installFatalHandlers } from "./kernel/log.ts";
import type { Server } from "./apps/server/index.ts";

let server: Server | undefined;
const uninstall = installFatalHandlers(() => server?.logDescriptor() ?? 2);
try {
  const { runCLI } = await import("./apps/cli/index.ts");
  process.exitCode = await runCLI(process.argv, (value) => {
    server = value;
  });
} finally {
  uninstall();
}

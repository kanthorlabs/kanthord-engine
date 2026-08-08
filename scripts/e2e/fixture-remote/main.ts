import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { seedRepositories } from "../../../test/helpers/remote/seed.ts";
import { startHttpRemote } from "../../../test/helpers/remote/http.ts";

function readOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) {
    throw new Error(`fixture-remote: missing required argument ${name}`);
  }
  return value;
}

export async function main(argv: readonly string[]): Promise<number> {
  const bind = readOption(argv, "--bind");
  const port = Number.parseInt(readOption(argv, "--port"), 10);

  const tools = resolveTools(process.env, ["git"]);
  const seed = seedRepositories(tools);
  const remote = await startHttpRemote(tools, seed, { bind, port });

  process.stdout.write(`fixture-remote: ready ${remote.origin}\n`);

  process.once("SIGTERM", () => {
    void remote.dispose().then(() => {
      process.exit(0);
    });
  });

  return 0;
}

process.exitCode = await main(process.argv.slice(2));

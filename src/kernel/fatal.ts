import { writeSync } from "node:fs";

export function installFatalHandlers(descriptor: () => number): () => void {
  function fatal(kind: string, reason: unknown): never {
    try {
      const record = {
        level: 60,
        kind,
        error_type:
          reason instanceof Error ? reason.constructor.name : typeof reason,
        // Keep frames only; multiline messages and rejection values are excluded.
        frames:
          reason instanceof Error
            ? (reason.stack ?? "")
                .split("\n")
                .filter((line) => /^\s+at /.test(line))
            : [],
      };
      writeSync(descriptor(), `${JSON.stringify(record)}\n`);
    } catch {
      /* Fatal output is best effort; termination is mandatory. */
    }
    process.exit(1);
  }
  const exception = (reason: Error) => fatal("uncaughtException", reason);
  const rejection = (reason: unknown) => fatal("unhandledRejection", reason);
  process.on("uncaughtException", exception);
  process.on("unhandledRejection", rejection);
  return () => {
    process.off("uncaughtException", exception);
    process.off("unhandledRejection", rejection);
  };
}

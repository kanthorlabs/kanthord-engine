import { rmSync, writeFileSync } from "node:fs";

export type SecretFileSink = Readonly<{
  write(text: string): void;
  discard(): void;
}>;

export function createSecretFile(path: string): SecretFileSink {
  let created = false;
  return {
    write: (text) => {
      if (created) {
        writeFileSync(path, text, "utf8");
        return;
      }
      writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      created = true;
    },
    discard: () => {
      rmSync(path, { force: true });
    },
  };
}

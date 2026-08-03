import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type TemporaryHome = Readonly<{
  path: string;
  writeConfig(overrides?: Readonly<Record<string, unknown>>): string;
  dispose(): void;
}>;

export function createTemporaryHome(): TemporaryHome {
  const homePath = fs.mkdtempSync(join(tmpdir(), "kanthord-home-"));

  return {
    path: homePath,
    writeConfig(overrides) {
      const base: Record<string, unknown> = {
        home: homePath,
        actor: "ulrich",
        masterKey: Buffer.alloc(32, 7).toString("base64"),
        http: {
          bind: "127.0.0.1",
          port: 7421,
          token: "test-token",
          allowedHosts: ["127.0.0.1:7421"],
        },
        attemptLimit: 3,
      };

      if (overrides) {
        for (const key of Object.keys(overrides)) {
          const value = overrides[key];
          if (
            key === "http" &&
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
          ) {
            base.http = { ...(base.http as Record<string, unknown>), ...value };
          } else if (value === undefined) {
            delete base[key];
          } else {
            base[key] = value;
          }
        }
      }

      const configPath = join(homePath, "kanthord.config.json");
      fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
      return configPath;
    },
    dispose() {
      fs.rmSync(homePath, { recursive: true, force: true });
    },
  };
}

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ConvictConfig } from "./convict.ts";
import type { LoadInput, Settings, ConfigErrorCode } from "./index.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kanthord-config-"));
}

function writeJson(dir: string, obj: unknown): string {
  const filePath = path.join(dir, "config.json");
  fs.writeFileSync(filePath, JSON.stringify(obj));
  return filePath;
}

function validFile(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const masterKey = Buffer.alloc(32).toString("base64");
  return {
    home: "/tmp/kanthord-home",
    actor: "test-actor",
    masterKey,
    http: {
      bind: "127.0.0.1",
      port: 8080,
      token: "test-token",
      allowedHosts: ["localhost:8080"],
    },
    attemptLimit: 3,
    ...overrides,
  };
}

function loadInput(
  dir: string,
  filePath: string,
  overrides?: Partial<LoadInput>,
): LoadInput {
  return {
    explicitConfigPath: filePath,
    env: {},
    cwd: dir,
    homeDir: "/home/user",
    etcDir: "/fixture-etc",
    ...overrides,
  };
}

describe("src/services/config/convict.test", () => {
  const config = new ConvictConfig();

  describe("happy path", () => {
    it("returns Settings with each value from a complete file", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.home, "/tmp/kanthord-home");
        assert.equal(result.settings.actor, "test-actor");
        assert.ok(Buffer.isBuffer(result.settings.masterKey));
        assert.equal(result.settings.masterKey.length, 32);
        assert.equal(result.settings.http.bind, "127.0.0.1");
        assert.equal(result.settings.http.port, 8080);
        assert.equal(result.settings.http.token, "test-token");
        assert.deepEqual(result.settings.http.allowedHosts, ["localhost:8080"]);
        assert.equal(result.settings.attemptLimit, 3);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("defaults attemptLimit to 3 when omitted", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).attemptLimit;
        const filePath = writeJson(dir, file);
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.attemptLimit, 3);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("populates discovery.resolved and discovery.searched with the explicit path", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.discovery.resolved, filePath);
        assert.deepEqual(result.discovery.searched, [filePath]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("Settings key order is home, actor, masterKey, http, attemptLimit", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(Object.keys(result.settings), [
          "home",
          "actor",
          "masterKey",
          "http",
          "attemptLimit",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("Settings carries no masterKeyFile key", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.equal((result.settings as any).masterKeyFile, undefined);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-not-found", () => {
    it("throws ConfigError with code config-not-found for absent path", () => {
      const dir = tmpDir();
      try {
        const filePath = path.join(dir, "missing.json");
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.name, "ConfigError");
            assert.equal(err.code, "config-not-found");
            assert.match(
              err.message,
              new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-invalid — parse errors", () => {
    it("throws config-invalid for a file holding {", () => {
      const dir = tmpDir();
      try {
        const filePath = path.join(dir, "bad.json");
        fs.writeFileSync(filePath, "{");
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-invalid — missing required fields", () => {
    it("throws config-invalid when home is omitted", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).home;
        const filePath = writeJson(dir, file);
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid when actor is omitted", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).actor;
        const filePath = writeJson(dir, file);
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid when http.port is omitted", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).http.port;
        const filePath = writeJson(dir, file);
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid when http.allowedHosts is omitted", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).http.allowedHosts;
        const filePath = writeJson(dir, file);
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-invalid — empty-string guards on custom formats", () => {
    for (const [label, override] of [
      ['actor: ""', { actor: "" }],
      ['home: ""', { home: "" }],
      [
        'http.bind: ""',
        { http: { bind: "", port: 8080, token: "t", allowedHosts: ["h:1"] } },
      ],
      [
        "http.allowedHosts: []",
        {
          http: { bind: "127.0.0.1", port: 8080, token: "t", allowedHosts: [] },
        },
      ],
      [
        'http.allowedHosts: [""]',
        {
          http: {
            bind: "127.0.0.1",
            port: 8080,
            token: "t",
            allowedHosts: [""],
          },
        },
      ],
      [
        'http.allowedHosts: ", ,"',
        {
          http: {
            bind: "127.0.0.1",
            port: 8080,
            token: "t",
            allowedHosts: ", ,",
          },
        },
      ],
    ] as const) {
      it(`throws config-invalid for ${label}`, () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile(override));
          assert.throws(
            () => config.load(loadInput(dir, filePath)),
            (err: any) => {
              assert.equal(err.code, "config-invalid");
              return true;
            },
          );
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });
    }
  });

  describe("config-invalid — unknown keys (strict mode)", () => {
    it("throws config-invalid for an unknown key", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ unknownKey: "oops" }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-invalid — http.port validation", () => {
    it('throws config-invalid for http.port: "not-a-port"', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: "not-a-port",
              token: "t",
              allowedHosts: ["h:1"],
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid for http.port: 70000", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 70000,
              token: "t",
              allowedHosts: ["h:1"],
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-invalid — attemptLimit validation", () => {
    it("throws config-invalid for attemptLimit: 0", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ attemptLimit: 0 }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid for attemptLimit: -1", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ attemptLimit: -1 }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid for attemptLimit: 1.5", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ attemptLimit: 1.5 }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("loads attemptLimit: 1", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ attemptLimit: 1 }));
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.attemptLimit, 1);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("env overrides", () => {
    it("input.env KANTHORD_ACTOR wins over file actor", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ actor: "from-file" }));
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_ACTOR: "from-env" },
          }),
        );
        assert.equal(result.settings.actor, "from-env");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("input.env KANTHORD_HTTP_PORT wins over file http.port", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_HTTP_PORT: "9999" },
          }),
        );
        assert.equal(result.settings.http.port, 9999);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('KANTHORD_HTTP_ALLOWED_HOSTS="a:1, b:2 ,,c:3" yields ["a:1", "b:2", "c:3"]', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_HTTP_ALLOWED_HOSTS: "a:1, b:2 ,,c:3" },
          }),
        );
        assert.deepEqual(result.settings.http.allowedHosts, [
          "a:1",
          "b:2",
          "c:3",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("homeOverride", () => {
    it("homeOverride wins over home from file", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ home: "/from-file" }));
        const result = config.load(
          loadInput(dir, filePath, {
            homeOverride: "/from-override",
          }),
        );
        assert.equal(result.settings.home, "/from-override");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("homeOverride wins over home from environment", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            homeOverride: "/from-override",
            env: { KANTHORD_HOME: "/from-env" },
          }),
        );
        assert.equal(result.settings.home, "/from-override");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("master key resolution", () => {
    it("masterKeyFile with trailing newline yields same Buffer as equivalent masterKey", () => {
      const dir = tmpDir();
      try {
        const keyBytes = Buffer.alloc(32);
        const base64 = keyBytes.toString("base64");
        const keyFilePath = path.join(dir, "master.key");
        fs.writeFileSync(keyFilePath, base64 + "\n", { mode: 0o600 });

        const filePathWithFile = writeJson(
          dir,
          validFile({
            masterKey: "",
            masterKeyFile: keyFilePath,
          }),
        );
        const resultFile = config.load(loadInput(dir, filePathWithFile));

        const filePathWithValue = writeJson(
          dir,
          validFile({ masterKey: base64 }),
        );
        const resultValue = config.load(loadInput(dir, filePathWithValue));

        assert.ok(
          resultFile.settings.masterKey.equals(resultValue.settings.masterKey),
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("31-byte base64 masterKey throws config-invalid naming 31", () => {
      const dir = tmpDir();
      try {
        const shortKey = Buffer.alloc(31).toString("base64");
        const filePath = writeJson(dir, validFile({ masterKey: shortKey }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.match(err.message, /31/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("config-refused — startup refusal rules", () => {
    it("http.bind 0.0.0.0 with no http.token throws config-refused", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "0.0.0.0",
              port: 8080,
              token: "",
              allowedHosts: ["h:1"],
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("http.bind 0.0.0.0 with non-empty http.token loads", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "0.0.0.0",
              port: 8080,
              token: "my-token",
              allowedHosts: ["h:1"],
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.bind, "0.0.0.0");
        assert.equal(result.settings.http.token, "my-token");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("neither masterKey nor masterKeyFile throws config-refused", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({ masterKey: "", masterKeyFile: "" }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("both masterKey and masterKeyFile throws config-refused", () => {
      const dir = tmpDir();
      try {
        const keyBytes = Buffer.alloc(32);
        const base64 = keyBytes.toString("base64");
        const keyFilePath = path.join(dir, "master.key");
        fs.writeFileSync(keyFilePath, base64 + "\n", { mode: 0o600 });

        const filePath = writeJson(
          dir,
          validFile({
            masterKeyFile: keyFilePath,
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("masterKeyFile with mode 0o644 throws config-refused; same file after chmod 0o600 loads", () => {
      const dir = tmpDir();
      try {
        const keyBytes = Buffer.alloc(32);
        const base64 = keyBytes.toString("base64");
        const keyFilePath = path.join(dir, "master.key");
        fs.writeFileSync(keyFilePath, base64 + "\n", { mode: 0o644 });

        const filePath = writeJson(
          dir,
          validFile({
            masterKey: "",
            masterKeyFile: keyFilePath,
          }),
        );

        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            return true;
          },
        );

        fs.chmodSync(keyFilePath, 0o600);
        const result = config.load(loadInput(dir, filePath));
        assert.ok(Buffer.isBuffer(result.settings.masterKey));
        assert.equal(result.settings.masterKey.length, 32);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("masterKeyFile naming a missing path throws config-invalid", () => {
      const dir = tmpDir();
      try {
        const missingKeyPath = path.join(dir, "does-not-exist.key");
        const filePath = writeJson(
          dir,
          validFile({
            masterKey: "",
            masterKeyFile: missingKeyPath,
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("search-order loading", () => {
    it("config file at join(cwd, kanthord.config.json) loads with no explicitConfigPath", () => {
      const dir = tmpDir();
      try {
        const configPath = path.join(dir, "kanthord.config.json");
        fs.writeFileSync(configPath, JSON.stringify(validFile()));
        const result = config.load({
          env: {},
          cwd: dir,
          homeDir: "/home/user",
          etcDir: "/fixture-etc",
        });
        assert.equal(result.discovery.resolved, configPath);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("KANTHORD_CONFIG pointing at second valid file wins", () => {
      const dir = tmpDir();
      try {
        const cwdConfig = path.join(dir, "kanthord.config.json");
        fs.writeFileSync(
          cwdConfig,
          JSON.stringify(validFile({ actor: "from-cwd" })),
        );

        const overrideConfig = path.join(dir, "override.json");
        fs.writeFileSync(
          overrideConfig,
          JSON.stringify(validFile({ actor: "from-override" })),
        );

        const result = config.load({
          env: { KANTHORD_CONFIG: overrideConfig },
          cwd: dir,
          homeDir: "/home/user",
          etcDir: "/fixture-etc",
        });
        assert.equal(result.discovery.resolved, overrideConfig);
        assert.equal(result.settings.actor, "from-override");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("no file at any candidate throws config-not-found with all candidate paths", () => {
      const dir = tmpDir();
      try {
        const cwd = dir;
        const homeDir = "/home/user";
        const etcDir = "/fixture-etc";
        assert.throws(
          () =>
            config.load({
              env: {},
              cwd,
              homeDir,
              etcDir,
            }),
          (err: any) => {
            assert.equal(err.code, "config-not-found");
            assert.match(err.message, /searched:/);
            assert.match(
              err.message,
              new RegExp(
                path
                  .join(cwd, "kanthord.config.json")
                  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              ),
            );
            assert.match(
              err.message,
              new RegExp(
                path
                  .join(homeDir, ".config/kanthord/config.json")
                  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              ),
            );
            assert.match(
              err.message,
              new RegExp(
                path
                  .join(etcDir, "kanthord/config.json")
                  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              ),
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("explicitConfigPath naming missing file throws config-not-found naming only that path", () => {
      const dir = tmpDir();
      try {
        const cwdConfig = path.join(dir, "kanthord.config.json");
        fs.writeFileSync(cwdConfig, JSON.stringify(validFile()));
        const missingPath = path.join(dir, "does-not-exist.json");

        assert.throws(
          () =>
            config.load({
              explicitConfigPath: missingPath,
              env: {},
              cwd: dir,
              homeDir: "/home/user",
              etcDir: "/fixture-etc",
            }),
          (err: any) => {
            assert.equal(err.code, "config-not-found");
            assert.match(
              err.message,
              new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            );
            assert.doesNotMatch(err.message, /searched:/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("discovery.searched holds all candidates for a resolved search-order load", () => {
      const dir = tmpDir();
      try {
        const configPath = path.join(dir, "kanthord.config.json");
        fs.writeFileSync(configPath, JSON.stringify(validFile()));
        const result = config.load({
          env: {},
          cwd: dir,
          homeDir: "/home/user",
          etcDir: "/fixture-etc",
        });
        assert.equal(result.discovery.searched.length, 3);
        assert.equal(
          result.discovery.searched[0],
          path.join(dir, "kanthord.config.json"),
        );
        assert.equal(
          result.discovery.searched[1],
          path.join("/home/user", ".config/kanthord/config.json"),
        );
        assert.equal(
          result.discovery.searched[2],
          "/fixture-etc/kanthord/config.json",
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });
});

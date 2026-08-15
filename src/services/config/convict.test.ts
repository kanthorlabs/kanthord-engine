import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ConvictConfig } from "./convict.ts";
import { ConfigError } from "./index.ts";
import type { LoadInput } from "./index.ts";

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

    it("Settings key order is home, actor, masterKey, http, tools, attemptLimit", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(Object.keys(result.settings), [
          "home",
          "actor",
          "masterKey",
          "http",
          "tools",
          "attemptLimit",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("defaults the three tool paths when the file names none", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.tools, {
          git: "/usr/bin/git",
          ssh: "/usr/bin/ssh",
          sshKeyscan: "/usr/bin/ssh-keyscan",
        });
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

    it("uses default port 31415 when http.port is omitted", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).http.port;
        const filePath = writeJson(dir, file);
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.port, 31415);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("omitting http.allowedHosts on a loopback bind loads the derived list", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).http.allowedHosts;
        const filePath = writeJson(dir, file);
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedHosts, [
          "127.0.0.1:8080",
          "localhost:8080",
        ]);
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

    it("KANTHORD_ATTEMPT_LIMIT=7 wins over file attemptLimit", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ attemptLimit: 3 }));
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_ATTEMPT_LIMIT: "7" },
          }),
        );
        assert.equal(result.settings.attemptLimit, 7);
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

  describe("config-invalid — tools validation", () => {
    it("throws config-invalid for tools.git: relative path, message names absolute path", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ tools: { git: "git" } }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.match(err.message, /must be an absolute path/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid for tools.git: empty string", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile({ tools: { git: "" } }));
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.match(err.message, /must be a non-empty string/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("throws config-invalid naming the nested unknown tool key", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({ tools: { unknownTool: "/bin/x" } }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.match(err.message, /unknownTool/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("env overrides — tools", () => {
    it("KANTHORD_TOOLS_GIT overrides tools.git and the others keep their defaults", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_TOOLS_GIT: "/opt/git/bin/git" },
          }),
        );
        assert.equal(result.settings.tools.git, "/opt/git/bin/git");
        assert.equal(result.settings.tools.ssh, "/usr/bin/ssh");
        assert.equal(result.settings.tools.sshKeyscan, "/usr/bin/ssh-keyscan");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("a relative KANTHORD_TOOLS_SSH throws config-invalid", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        assert.throws(
          () =>
            config.load(
              loadInput(dir, filePath, {
                env: { KANTHORD_TOOLS_SSH: "relative/ssh" },
              }),
            ),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.match(err.message, /must be an absolute path/);
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

    it("non-empty http.allowedOrigins with empty http.token throws config-refused naming http.token", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: ["http://localhost:8080"],
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            assert.match(err.message, /http\.token/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("non-empty http.allowedOrigins with non-empty http.token loads", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "my-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: ["http://localhost:8080"],
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedOrigins, [
          "http://localhost:8080",
        ]);
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

    it("masterKeyFile naming a directory at mode 0600 throws config-refused naming the path and EISDIR, not a raw system error", () => {
      const dir = tmpDir();
      try {
        const keyDir = path.join(dir, "master.keydir");
        fs.mkdirSync(keyDir);
        fs.chmodSync(keyDir, 0o600);
        const filePath = writeJson(
          dir,
          validFile({
            masterKey: "",
            masterKeyFile: keyDir,
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: unknown) => {
            assert.ok(
              err instanceof ConfigError,
              "the read failure must convert to ConfigError, not escape raw",
            );
            assert.equal(err.code, "config-refused");
            assert.equal(
              err.message,
              `masterKeyFile refused at ${keyDir}: EISDIR`,
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("masterKeyFile naming a self-referential symlink throws config-refused naming the path and ELOOP", () => {
      const dir = tmpDir();
      try {
        const loopPath = path.join(dir, "loop.key");
        fs.symlinkSync(loopPath, loopPath);
        const filePath = writeJson(
          dir,
          validFile({
            masterKey: "",
            masterKeyFile: loopPath,
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: unknown) => {
            assert.ok(
              err instanceof ConfigError,
              "the stat failure must convert to ConfigError, not escape raw",
            );
            assert.equal(err.code, "config-refused");
            assert.equal(
              err.message,
              `masterKeyFile refused at ${loopPath}: ELOOP`,
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("self-referential masterKeyFile and tokenFile refuse with the exact master-key ELOOP message and no token-file path", () => {
      const dir = tmpDir();
      try {
        const loopKey = path.join(dir, "loop.key");
        fs.symlinkSync(loopKey, loopKey);
        const loopToken = path.join(dir, "loop.token");
        fs.symlinkSync(loopToken, loopToken);
        const filePath = writeJson(
          dir,
          validFile({
            masterKey: "",
            masterKeyFile: loopKey,
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: loopToken,
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: unknown) => {
            assert.ok(err instanceof ConfigError);
            assert.equal(err.code, "config-refused");
            assert.equal(
              err.message,
              `masterKeyFile refused at ${loopKey}: ELOOP`,
            );
            assert.doesNotMatch(err.message, /http\.tokenFile/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("derived http.allowedHosts", () => {
    it("omitting http.allowedHosts on the bind 0.0.0.0 throws config-refused naming http.allowedHosts", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: { bind: "0.0.0.0", port: 8080, token: "test-token" },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            assert.match(err.message, /http\.allowedHosts/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("omitting http.allowedHosts on the bind :: throws config-refused", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: { bind: "::", port: 8080, token: "test-token" },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            assert.match(err.message, /http\.allowedHosts/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("omitting http.allowedHosts with a configured port of 0 throws config-refused", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: { bind: "127.0.0.1", port: 0, token: "test-token" },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            assert.match(err.message, /http\.allowedHosts/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("an explicit http.allowedHosts on the bind 0.0.0.0 loads that list verbatim", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "0.0.0.0",
              port: 8080,
              token: "test-token",
              allowedHosts: ["kanthord.internal:8080"],
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedHosts, [
          "kanthord.internal:8080",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("an explicit http.allowedHosts on a loopback bind loads verbatim rather than the derived list", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["h:1"],
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedHosts, ["h:1"]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("http.tokenFile", () => {
    it('a mode-0600 file holding "s3cret\\n" produces settings.http.token === "s3cret"', () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.token, "s3cret");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("a valid 0600 token file satisfies the non-loopback bind and non-empty allowedOrigins guards with its transformed content", () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "0.0.0.0",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: ["http://a.test"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.token, "s3cret");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('a file holding "s3cret\\n\\n" produces "s3cret\\n"', () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n\n", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.token, "s3cret\n");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('a file holding " pad " produces " pad " — no other trimming', () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, " pad ", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.token, " pad ");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("a missing http.tokenFile throws config-invalid with http.tokenFile not found: <path>", () => {
      const dir = tmpDir();
      try {
        const missingTokenPath = path.join(dir, "does-not-exist.token");
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: missingTokenPath,
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.equal(
              err.message,
              `http.tokenFile not found: ${missingTokenPath}`,
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("KANTHORD_HTTP_TOKEN_FILE sets the key from the environment", () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "from-env-file\n", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
            },
          }),
        );
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_HTTP_TOKEN_FILE: tokenFilePath },
          }),
        );
        assert.equal(result.settings.http.token, "from-env-file");
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('Object.hasOwn(settings.http, "tokenFile") is false', () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.equal(Object.hasOwn(result.settings.http, "tokenFile"), false);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("a config that sets http.token and no tokenFile produces the same Settings as before the change", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(loadInput(dir, filePath));
        assert.equal(result.settings.http.token, "test-token");
        assert.equal(Object.hasOwn(result.settings.http, "tokenFile"), false);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("http.token and http.tokenFile both set throws config-refused", () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n", { mode: 0o600 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "also-set",
              allowedHosts: ["localhost:8080"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            assert.equal(
              err.message,
              "http.token and http.tokenFile are both set; configure exactly one",
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it("http.tokenFile mode 0o644 throws config-refused naming found 0644", () => {
      const dir = tmpDir();
      try {
        const tokenFilePath = path.join(dir, "token.txt");
        fs.writeFileSync(tokenFilePath, "s3cret\n", { mode: 0o644 });
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "",
              allowedHosts: ["localhost:8080"],
              tokenFile: tokenFilePath,
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-refused");
            assert.match(err.message, /found 0644$/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("http.allowedOrigins", () => {
    it("omitting http.allowedOrigins from the config file loads and yields []", () => {
      const dir = tmpDir();
      try {
        const file = validFile();
        delete (file as any).http.allowedOrigins;
        const filePath = writeJson(dir, file);
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedOrigins, []);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('KANTHORD_HTTP_ALLOWED_ORIGINS="" yields [] and loads', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_HTTP_ALLOWED_ORIGINS: "" },
          }),
        );
        assert.deepEqual(result.settings.http.allowedOrigins, []);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('KANTHORD_HTTP_ALLOWED_ORIGINS="http://a.test, http://b.test ,,http://c.test" yields exactly ["http://a.test", "http://b.test", "http://c.test"]', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: {
              KANTHORD_HTTP_ALLOWED_ORIGINS:
                "http://a.test, http://b.test ,,http://c.test",
            },
          }),
        );
        assert.deepEqual(result.settings.http.allowedOrigins, [
          "http://a.test",
          "http://b.test",
          "http://c.test",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('KANTHORD_HTTP_ALLOWED_ORIGINS="http://LOCALHOST:80" yields exactly ["http://localhost"]', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: { KANTHORD_HTTP_ALLOWED_ORIGINS: "http://LOCALHOST:80" },
          }),
        );
        assert.deepEqual(result.settings.http.allowedOrigins, [
          "http://localhost",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    for (const badEntry of [
      "*",
      "http://*.test",
      "http://a.test/",
      "http://a.test/path",
      "ftp://a.test",
      "http://user:pw@a.test",
      "null",
      "http:a.test",
      "http://a.test?",
      "http://@a.test",
    ]) {
      it(`KANTHORD_HTTP_ALLOWED_ORIGINS naming ${JSON.stringify(badEntry)} throws config-invalid naming the entry`, () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          assert.throws(
            () =>
              config.load(
                loadInput(dir, filePath, {
                  env: { KANTHORD_HTTP_ALLOWED_ORIGINS: badEntry },
                }),
              ),
            (err: any) => {
              assert.equal(err.code, "config-invalid");
              assert.match(
                err.message,
                new RegExp(
                  JSON.stringify(badEntry).replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                  ),
                ),
              );
              return true;
            },
          );
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });
    }

    it("entry order is preserved, and a duplicate is kept", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(dir, validFile());
        const result = config.load(
          loadInput(dir, filePath, {
            env: {
              KANTHORD_HTTP_ALLOWED_ORIGINS:
                "http://b.test,http://a.test,http://b.test",
            },
          }),
        );
        assert.deepEqual(result.settings.http.allowedOrigins, [
          "http://b.test",
          "http://a.test",
          "http://b.test",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('a config file array ["http://LOCALHOST:80", "https://a.test:443"] loads and yields exactly ["http://localhost", "https://a.test"]', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: ["http://LOCALHOST:80", "https://a.test:443"],
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedOrigins, [
          "http://localhost",
          "https://a.test",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('a config file array ["http://a.test?q=1"] fails with config-invalid naming the entry', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: ["http://a.test?q=1"],
            },
          }),
        );
        assert.throws(
          () => config.load(loadInput(dir, filePath)),
          (err: any) => {
            assert.equal(err.code, "config-invalid");
            assert.match(err.message, /http:\/\/a\.test\?q=1/);
            return true;
          },
        );
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it('a config file array ["http://a.test#f"] fails with config-invalid', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: ["http://a.test#f"],
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

    it("a config file array [123] fails with config-invalid", () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: [123],
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

    it('a config file array [""] fails with config-invalid', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: [""],
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

    it('a config file string "http://a.test,http://b.test" loads and yields ["http://a.test", "http://b.test"]', () => {
      const dir = tmpDir();
      try {
        const filePath = writeJson(
          dir,
          validFile({
            http: {
              bind: "127.0.0.1",
              port: 8080,
              token: "test-token",
              allowedHosts: ["localhost:8080"],
              allowedOrigins: "http://a.test,http://b.test",
            },
          }),
        );
        const result = config.load(loadInput(dir, filePath));
        assert.deepEqual(result.settings.http.allowedOrigins, [
          "http://a.test",
          "http://b.test",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("http.idempotency", () => {
    describe("defaults", () => {
      it("a config file that omits http.idempotency yields the four defaults", () => {
        const dir = tmpDir();
        try {
          const file = validFile();
          const filePath = writeJson(dir, file);
          const result = config.load(loadInput(dir, filePath));
          assert.deepEqual(result.settings.http.idempotency, {
            ttl: 300,
            joinTimeout: 30,
            maxEntries: 256,
            maxBytes: 8388608,
          });
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("http.idempotency: {} yields the same four defaults", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(
            dir,
            validFile({
              http: { ...(validFile().http as object), idempotency: {} },
            }),
          );
          const result = config.load(loadInput(dir, filePath));
          assert.deepEqual(result.settings.http.idempotency, {
            ttl: 300,
            joinTimeout: 30,
            maxEntries: 256,
            maxBytes: 8388608,
          });
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("a partial http.idempotency group keeps the other defaults", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(
            dir,
            validFile({
              http: {
                ...(validFile().http as object),
                idempotency: { ttl: 60 },
              },
            }),
          );
          const result = config.load(loadInput(dir, filePath));
          assert.deepEqual(result.settings.http.idempotency, {
            ttl: 60,
            joinTimeout: 30,
            maxEntries: 256,
            maxBytes: 8388608,
          });
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });
    });

    describe("accepted values", () => {
      for (const [key, value] of [
        ["ttl", 0],
        ["joinTimeout", 0],
        ["joinTimeout", 1],
        ["maxEntries", 1],
        ["maxBytes", 1],
      ] as const) {
        it(`${key}: ${value} loads and yields ${value}`, () => {
          const dir = tmpDir();
          try {
            const filePath = writeJson(
              dir,
              validFile({
                http: {
                  ...(validFile().http as object),
                  idempotency: { [key]: value },
                },
              }),
            );
            const result = config.load(loadInput(dir, filePath));
            assert.equal(
              (result.settings.http.idempotency as Record<string, number>)[key],
              value,
            );
          } finally {
            fs.rmSync(dir, { recursive: true });
          }
        });
      }
    });

    describe("refusals", () => {
      for (const [key, value] of [
        ["ttl", -1],
        ["ttl", 1.5],
        ["ttl", "300"],
        ["joinTimeout", -1],
        ["joinTimeout", 1.5],
        ["maxEntries", 0],
        ["maxEntries", -1],
        ["maxEntries", 1.5],
        ["maxBytes", 0],
        ["maxBytes", 1.5],
      ] as const) {
        it(`${key}: ${JSON.stringify(value)} throws config-invalid`, () => {
          const dir = tmpDir();
          try {
            const filePath = writeJson(
              dir,
              validFile({
                http: {
                  ...(validFile().http as object),
                  idempotency: { [key]: value },
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
      }

      it("an unknown key http.idempotency.sweepInterval throws config-invalid, proving strict mode", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(
            dir,
            validFile({
              http: {
                ...(validFile().http as object),
                idempotency: { sweepInterval: 1 },
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

    describe("env overrides", () => {
      it("KANTHORD_HTTP_IDEMPOTENCY_TTL=60 yields ttl 60", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_TTL: "60" },
            }),
          );
          assert.equal(result.settings.http.idempotency.ttl, 60);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("KANTHORD_HTTP_IDEMPOTENCY_TTL=0 yields ttl 0", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_TTL: "0" },
            }),
          );
          assert.equal(result.settings.http.idempotency.ttl, 0);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT=5 yields joinTimeout 5", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT: "5" },
            }),
          );
          assert.equal(result.settings.http.idempotency.joinTimeout, 5);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT=0 yields joinTimeout 0", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT: "0" },
            }),
          );
          assert.equal(result.settings.http.idempotency.joinTimeout, 0);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("KANTHORD_HTTP_IDEMPOTENCY_MAX_ENTRIES=10 yields maxEntries 10", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_MAX_ENTRIES: "10" },
            }),
          );
          assert.equal(result.settings.http.idempotency.maxEntries, 10);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("KANTHORD_HTTP_IDEMPOTENCY_MAX_BYTES=1024 yields maxBytes 1024", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_MAX_BYTES: "1024" },
            }),
          );
          assert.equal(result.settings.http.idempotency.maxBytes, 1024);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("KANTHORD_HTTP_IDEMPOTENCY_TTL=abc throws config-invalid", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(dir, validFile());
          assert.throws(
            () =>
              config.load(
                loadInput(dir, filePath, {
                  env: { KANTHORD_HTTP_IDEMPOTENCY_TTL: "abc" },
                }),
              ),
            (err: any) => {
              assert.equal(err.code, "config-invalid");
              return true;
            },
          );
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });

      it("an env value overrides a config-file value: file ttl 30 plus env 90 yields 90", () => {
        const dir = tmpDir();
        try {
          const filePath = writeJson(
            dir,
            validFile({
              http: {
                ...(validFile().http as object),
                idempotency: { ttl: 30 },
              },
            }),
          );
          const result = config.load(
            loadInput(dir, filePath, {
              env: { KANTHORD_HTTP_IDEMPOTENCY_TTL: "90" },
            }),
          );
          assert.equal(result.settings.http.idempotency.ttl, 90);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
      });
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

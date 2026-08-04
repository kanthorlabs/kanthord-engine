import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintCase } from "./lint.ts";

describe("test/helpers/lint.test", () => {
  it("service same-capability import is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "src/services/config/convict.ts",
      code: 'import { x } from "./search-order.ts";\nconsole.log(x);\n',
    });
    assert.deepEqual(ruleIds, []);
  });

  it("service importing domain is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "src/services/config/convict.ts",
      code: 'import { version } from "../../domain/version.ts";\nconsole.log(version);\n',
    });
    assert.deepEqual(ruleIds, []);
  });

  it("service importing composition-root is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "src/services/config/convict.ts",
      code: 'import { app } from "../../main.ts";\nconsole.log(app);\n',
    });
    assert.deepEqual(ruleIds, ["boundaries/dependencies"]);
  });

  it("domain importing node:fs is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "src/domain/version.ts",
      code: 'import fs from "node:fs";\nconsole.log(fs);\n',
    });
    assert.deepEqual(ruleIds, ["no-restricted-imports"]);
  });

  it("domain importing service implementation is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "src/domain/version.ts",
      code: 'import { config } from "../services/config/index.ts";\nconsole.log(config);\n',
    });
    assert.deepEqual(ruleIds, ["boundaries/dependencies"]);
  });

  it("test importing composition-root is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "test/helpers/lint.test.ts",
      code: 'import { app } from "../../src/main.ts";\nconsole.log(app);\n',
    });
    assert.deepEqual(ruleIds, ["boundaries/dependencies"]);
  });

  it("test helper importing eslint package is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "test/helpers/lint.ts",
      code: 'import { ESLint } from "eslint";\nconsole.log(ESLint);\n',
    });
    assert.deepEqual(ruleIds, []);
  });

  it("composition-root importing service is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "src/main.ts",
      code: 'import { convict } from "./services/config/convict.ts";\nconsole.log(convict);\n',
    });
    assert.deepEqual(ruleIds, []);
  });

  it("home-lock importing another capability's implementation is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "src/services/home-lock/sqlite.ts",
      code: 'import { convict } from "../config/convict.ts";\nconsole.log(convict);\n',
    });
    assert.deepEqual(ruleIds, ["boundaries/dependencies"]);
  });

  it("home-lock importing another capability's interface is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "src/services/home-lock/sqlite.ts",
      code: 'import { config } from "../config/index.ts";\nconsole.log(config);\n',
    });
    assert.deepEqual(ruleIds, []);
  });

  it("test-helper importing composition-root is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "test/helpers/daemon.ts",
      code: 'import { app } from "../../src/main.ts";\nconsole.log(app);\n',
    });
    assert.deepEqual(ruleIds, ["boundaries/dependencies"]);
  });

  it("test-helper importing another test-helper is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "test/helpers/daemon.ts",
      code: 'import { home } from "./home.ts";\nconsole.log(home);\n',
    });
    assert.deepEqual(ruleIds, []);
  });

  it("cli importing http/contract is clean", async () => {
    const ruleIds = await lintCase({
      filePath: "src/cli/client.ts",
      code: 'import { registry } from "../http/contract/registry.ts";\nconsole.log(registry);\n',
    });
    assert.equal(ruleIds.includes("boundaries/dependencies"), false);
  });

  it("cli importing a service implementation is blocked", async () => {
    const ruleIds = await lintCase({
      filePath: "src/cli/client.ts",
      code: 'import { SqliteStorage } from "../services/storage/sqlite.ts";\nconsole.log(SqliteStorage);\n',
    });
    assert.equal(ruleIds.includes("boundaries/dependencies"), true);
  });
});

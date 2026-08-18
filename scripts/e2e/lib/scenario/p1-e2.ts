import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { allocateLocalPort, createLocalDriver } from "../driver/local.ts";
import type { DaemonConfig } from "../driver/index.ts";
import { createFixtureProfile } from "../profile/fixture.ts";
import { takeTemporaryDirectory } from "../resources.ts";
import type { ScenarioDeclaration } from "./index.ts";
import type { ScenarioContext } from "./context.ts";
import { runStartupRefusal, runTransportCases } from "./transport.ts";
import { resolveTools } from "./tools.ts";

async function run(context: ScenarioContext): Promise<void> {
  const driver = await createLocalDriver(context);
  await createFixtureProfile(context, driver, "two-objective");

  const workspace = await takeTemporaryDirectory(
    context,
    "kanthord-e2e-p1-e2-",
  );

  const home = join(workspace, "home");
  await mkdir(home, { recursive: true });

  const port = await allocateLocalPort();
  const token = randomBytes(16).toString("hex");
  const daemonConfig: DaemonConfig = {
    home,
    actor: "e2e-p1-e2",
    masterKey: randomBytes(32).toString("base64"),
    http: {
      bind: "127.0.0.1",
      port,
      token,
      allowedHosts: [`127.0.0.1:${String(port)}`],
    },
    tools: resolveTools(),
    attemptLimit: 3,
    leaseTtlMs: 300000,
  };

  const handle = await driver.startDaemon(daemonConfig);
  await runTransportCases(
    context,
    { allowedHost: handle.allowedHost, token },
    driver.issue,
  );
  await handle.stop();

  await runStartupRefusal(context, driver);
}

export const p1e2: ScenarioDeclaration = {
  id: "P1-E2",
  mode: "deterministic",
  driver: "local",
  profile: "fixture",
  plan: "two-objective",
  run,
};

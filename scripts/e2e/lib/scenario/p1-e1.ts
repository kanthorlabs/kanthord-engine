import { createLocalDriver } from "../driver/local.ts";
import { createFixtureProfile } from "../profile/fixture.ts";
import type { ScenarioDeclaration } from "./index.ts";
import type { ScenarioContext } from "./context.ts";
import { runJourney } from "./journey.ts";

async function run(context: ScenarioContext): Promise<void> {
  const driver = await createLocalDriver(context);
  const profile = await createFixtureProfile(context, driver);
  await runJourney(context, driver, profile);
}

export const p1e1: ScenarioDeclaration = {
  id: "P1-E1",
  mode: "deterministic",
  driver: "local",
  profile: "fixture",
  run,
};

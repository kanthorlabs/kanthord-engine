import type { DriverName } from "../driver/index.ts";
import type { ProfileName } from "../profile/index.ts";
import type { ScenarioId } from "../tag.ts";
import type { ScenarioContext } from "./context.ts";
import { p1e1 } from "./p1-e1.ts";
import { p1e2 } from "./p1-e2.ts";
import { p1e4 } from "./p1-e4.ts";
import { p1e5 } from "./p1-e5.ts";

export type { ScenarioId } from "../tag.ts";

export type ScenarioDeclaration = Readonly<{
  id: ScenarioId;
  mode: "deterministic" | "integration" | "deployment";
  driver: DriverName;
  profile: ProfileName;
  run(context: ScenarioContext): Promise<void>;
}>;

export const scenarios: readonly ScenarioDeclaration[] = [
  {
    id: "P1-E1",
    mode: "deterministic",
    driver: "local",
    profile: "fixture",
    run: p1e1.run,
  },
  {
    id: "P1-E2",
    mode: "deterministic",
    driver: "local",
    profile: "fixture",
    run: p1e2.run,
  },
  {
    id: "P1-E4",
    mode: "deterministic",
    driver: "podman",
    profile: "fixture",
    run: p1e4.run,
  },
  {
    id: "P1-E5",
    mode: "integration",
    driver: "local",
    profile: "real",
    run: p1e5.run,
  },
];

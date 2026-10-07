import type { Migration } from "../kernel/store.ts";
export { IntakeService, type Dependencies } from "./service.ts";
export const intakeMigrations: readonly Migration[] = [];
export const intakeConfigSchema = {};

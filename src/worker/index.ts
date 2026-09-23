import type { Migration } from "../kernel/store.ts";
export { WorkerService, type Dependencies } from "./service.ts";
export const workerMigrations: readonly Migration[] = [];
export const workerConfigSchema = {};

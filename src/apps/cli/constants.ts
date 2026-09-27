export const PROGRAM_NAME = "kanthord";
export const CommandName = {
  Config: "config",
  Serve: "serve",
  JWT: "jwt",
  Gateway: "gateway",
  Worker: "worker",
  Credential: "credential",
  Project: "project",
  Mission: "mission",
  Scheduler: "scheduler",
  Tracking: "tracking",
} as const;
export const SERVER_APPLICATION = "server";
export const ExitCode = { Success: 0, Failure: 1 } as const;

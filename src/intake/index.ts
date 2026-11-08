export { IntakeService, type Dependencies } from "./service.ts";
export { intakeMigrations } from "./migrations.ts";
export {
  IntakeCredentials,
  type IntakeCredentialDependencies,
} from "./credential.ts";
export { INTAKE_PLATFORMS } from "./credential-platform.ts";
export { decodeJiraLinkUpdate, type DecodedJiraLinkUpdate } from "./jira.ts";
export { decodeSlackLinkUpdate, type DecodedSlackLinkUpdate } from "./slack.ts";
export const intakeConfigSchema = {};
export { IntakeFootprint, oldestInboundEvent } from "./footprint.ts";

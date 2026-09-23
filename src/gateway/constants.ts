export const KANTHORD_AUTH_USERNAME = "kanthorlabs";
export const MAX_HUMAN_USERNAME_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_BINDING_ID_LENGTH = 128;
export const MAX_RUNTIME_IDENTITY_LENGTH = 128;
export const CLIENT_IDENTITY_PREFIX = "client_identity";

export const AccessPolicy = {
  Human: "human",
  Client: "client",
  Public: "public",
  Delivery: "delivery",
} as const;
export type AccessPolicy = (typeof AccessPolicy)[keyof typeof AccessPolicy];

export const OperationInteraction = {
  Delivery: "delivery",
  Stream: "stream",
} as const;
export type OperationInteraction =
  (typeof OperationInteraction)[keyof typeof OperationInteraction];

export const IdentityKind = { Human: "human", Client: "client" } as const;

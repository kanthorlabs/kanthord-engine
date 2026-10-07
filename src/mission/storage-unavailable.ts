import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { MissionErrorCode, type IntakeStorage } from "./contract.ts";

function refuse(): never {
  throw new OperationError(
    HttpStatus.ServiceUnavailable,
    MissionErrorCode.EvidenceStorageUnavailable,
    "No object storage is wired.",
  );
}

export const unavailableStorage: IntakeStorage = {
  put: async () => refuse(),
  check: async () => refuse(),
  get: async () => refuse(),
  executionGet: async () => refuse(),
  delete: async () => refuse(),
};

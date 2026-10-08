import { Platform } from "./platforms.ts";
import { S3Platform } from "./s3.ts";

export { StorageComponent, type Dependencies } from "./service.ts";
export { STORAGE_PLATFORMS } from "./platforms.ts";
export {
  S3Platform,
  type PresignedGet,
  type PresignedPut,
  type S3Call,
  type S3ObjectTarget,
  type S3PutTarget,
} from "./s3.ts";

export const storageImplementations = {
  [Platform.S3]: S3Platform,
} as const;

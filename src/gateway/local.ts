import { fileURLToPath } from "node:url";
export {
  writeOpenAPI,
  emitOpenAPIFiles,
  emitOpenAPI,
  serializeOpenAPIFile,
} from "./openapi.ts";
export const openapiPath = () =>
  fileURLToPath(new URL("../../static/openapi.yaml", import.meta.url));

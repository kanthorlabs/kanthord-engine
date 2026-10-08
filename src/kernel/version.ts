import { z } from "zod";
import { packageManifest } from "./assets.ts";

const version = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(packageManifest())).version;

export function packageVersion(): string {
  return version;
}

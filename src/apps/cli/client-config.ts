import { join } from "node:path";
import { z } from "zod";
import { directories, parseMapping } from "../../config/index.ts";
import { audit, readPrivate } from "../../shared/files.ts";
import { Diagnostic } from "../../shared/errors.ts";

const endpoint = z.url().refine((value) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const clientSchema = z.strictObject({
  endpoint: endpoint.optional(),
  token: z.string().min(1).optional(),
});
export interface ClientConfiguration {
  endpoint: string;
  token?: string;
}
export const clientConfigPath = (env = process.env) =>
  join(directories(env).config, "cli.yaml");

export function resolveClient(
  options: Partial<ClientConfiguration> = {},
  env: NodeJS.ProcessEnv = process.env,
): ClientConfiguration {
  const path = clientConfigPath(env);
  let stored: z.infer<typeof clientSchema> = {};
  if (audit(path, "file", true)) {
    const result = clientSchema.safeParse(parseMapping(readPrivate(path)));
    if (!result.success)
      throw new Diagnostic(
        "cli.config.invalid",
        `${path}: invalid client configuration.`,
      );
    stored = result.data;
  }
  const resolved = {
    endpoint:
      options.endpoint ??
      env.KANTHORD_ENDPOINT ??
      stored.endpoint ??
      "http://127.0.0.1:31415",
    token: options.token ?? env.KANTHORD_TOKEN ?? stored.token,
  };
  if (!endpoint.safeParse(resolved.endpoint).success)
    throw new Diagnostic(
      "cli.config.invalid_endpoint",
      "endpoint: expected an absolute HTTP(S) URL without credentials, query or fragment.",
    );
  return resolved;
}

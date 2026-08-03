export type HttpSettings = Readonly<{
  bind: string;
  port: number;
  token: string;
  allowedHosts: readonly string[];
}>;

export type Settings = Readonly<{
  home: string;
  actor: string;
  masterKey: Buffer;
  http: HttpSettings;
  attemptLimit: number;
}>;

export type Discovery = Readonly<{
  resolved: string;
  searched: readonly string[];
}>;

export type Loaded = Readonly<{ settings: Settings; discovery: Discovery }>;

export type LoadInput = Readonly<{
  explicitConfigPath?: string;
  homeOverride?: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homeDir: string;
  etcDir: string;
}>;

export type ConfigErrorCode =
  "config-not-found" | "config-invalid" | "config-refused";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export interface Config {
  load(input: LoadInput): Loaded;
}

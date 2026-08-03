declare module "convict" {
  interface Config {
    load(data: Record<string, unknown>): Config;
    get(path: string): unknown;
    set(path: string, value: unknown): void;
    has(path: string): boolean;
    default(path: string): unknown;
    validate(opts?: { allowed?: string }): void;
    getProperties(): Record<string, unknown>;
    getSchema(): Record<string, unknown>;
    getSchemaString(): string;
    toString(): string;
  }

  function convict(
    schema: Record<string, unknown>,
    opts?: { env?: Record<string, string | undefined>; args?: string[] },
  ): Config;

  namespace convict {
    function addFormats(
      formats: Record<string, { validate: (value: unknown) => void }>,
    ): void;
  }

  export = convict;
}

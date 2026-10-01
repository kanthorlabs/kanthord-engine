declare module "convict" {
  export interface Field {
    doc: string;
    format: string | readonly string[] | ((value: unknown) => void);
    default: unknown;
    sensitive?: boolean;
  }
  export type Schema<T = Record<string, unknown>> = {
    [K in keyof T]: Field | Schema;
  };
  interface Config<T> {
    load(value: unknown): Config<T>;
    validate(options: { allowed: "strict" }): Config<T>;
    getProperties(): T;
    toString(): string;
  }
  interface Convict {
    <T>(
      schema: Schema,
      options: { args: string[]; env: Record<string, string> },
    ): Config<T>;
    addParser(parser: {
      extension: string[];
      parse: (source: string) => unknown;
    }): void;
    addFormat(format: {
      name: string;
      validate: (value: unknown) => void;
    }): void;
  }
  const convict: Convict;
  export default convict;
}

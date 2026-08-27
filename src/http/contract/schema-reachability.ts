const componentPrefix = "#/components/schemas/";

function decodePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function reachableSchemaNames(
  document: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const components = document.components as
    Readonly<Record<string, unknown>> | undefined;
  const schemas = (components?.schemas ?? {}) as Readonly<
    Record<string, unknown>
  >;

  const reached = new Set<string>();
  const pending: string[] = [];

  const collect = (raw: string): void => {
    if (!raw.startsWith(componentPrefix)) return;
    const name = decodePointer(raw.slice(componentPrefix.length));
    if (reached.has(name)) return;
    reached.add(name);
    pending.push(name);
  };

  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) scan(element);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "$ref" && typeof nested === "string") {
        collect(nested);
        continue;
      }
      if (
        key === "discriminator" &&
        nested !== null &&
        typeof nested === "object"
      ) {
        const mapping = (nested as Record<string, unknown>).mapping;
        if (mapping !== null && typeof mapping === "object") {
          for (const target of Object.values(
            mapping as Record<string, unknown>,
          )) {
            if (typeof target === "string") collect(target);
          }
        }
        continue;
      }
      scan(nested);
    }
  };

  for (const [key, value] of Object.entries(document)) {
    if (key === "components") continue;
    scan(value);
  }

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) continue;
    scan(schemas[name]);
  }

  return reached;
}

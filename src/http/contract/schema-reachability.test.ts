import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { reachableSchemaNames } from "./schema-reachability.ts";

describe("src/http/contract/schema-reachability", () => {
  test("follows a nested schema reference chain of depth three", () => {
    const document = {
      paths: {
        "/v1/example": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/A" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: {
            type: "object",
            properties: {
              nested: { $ref: "#/components/schemas/B" },
            },
          },
          B: {
            type: "array",
            items: { $ref: "#/components/schemas/C" },
          },
          C: { type: "object" },
          D: { type: "object" },
        },
      },
    };
    const result = reachableSchemaNames(document);
    const expected = ["A", "B", "C"];
    assert.deepEqual([...result].sort(), [...expected].sort());
  });

  test("follows every discriminator mapping target", () => {
    const document = {
      paths: {
        "/v1/example": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Parent" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Parent: {
            discriminator: {
              propertyName: "kind",
              mapping: {
                one: "#/components/schemas/One",
                two: "#/components/schemas/Two",
              },
            },
          },
          One: { type: "object" },
          Two: { type: "object" },
        },
      },
    };
    const result = reachableSchemaNames(document);
    const expected = ["Parent", "One", "Two"];
    assert.deepEqual([...result].sort(), [...expected].sort());
  });

  test("decodes a schema name that contains an escaped slash", () => {
    const document = {
      paths: {
        "/v1/example": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/a~1b" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          "a/b": { type: "object" },
        },
      },
    };
    const result = reachableSchemaNames(document);
    const expected = ["a/b"];
    assert.deepEqual([...result].sort(), [...expected].sort());
  });

  test("decodes escaped tildes without corrupting pointer order", () => {
    const tildeDocument = {
      paths: {
        "/v1/example": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/a~0b" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          "a~b": { type: "object" },
        },
      },
    };
    const tildeResult = reachableSchemaNames(tildeDocument);
    const tildeExpected = ["a~b"];
    assert.deepEqual([...tildeResult].sort(), [...tildeExpected].sort());

    const orderDocument = {
      paths: {
        "/v1/example": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/~01" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          "~1": { type: "object" },
        },
      },
    };
    const orderResult = reachableSchemaNames(orderDocument);
    const orderExpected = ["~1"];
    assert.deepEqual([...orderResult].sort(), [...orderExpected].sort());
    assert.equal(orderResult.has("/"), false);
  });

  test("terminates when two schemas refer to each other", () => {
    const document = {
      paths: {
        "/v1/example": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/X" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          X: { properties: { next: { $ref: "#/components/schemas/Y" } } },
          Y: { properties: { next: { $ref: "#/components/schemas/X" } } },
        },
      },
    };
    const result = reachableSchemaNames(document);
    const expected = ["X", "Y"];
    assert.deepEqual([...result].sort(), [...expected].sort());
  });

  test("seeds from root extensions but not from components", () => {
    const documentA = {
      paths: {},
      components: {
        schemas: {
          T: { type: "object" },
        },
      },
      "x-kanthord-event-payloads": {
        t: { $ref: "#/components/schemas/T" },
      },
    };
    const resultA = reachableSchemaNames(documentA);
    const expectedA = ["T"];
    assert.deepEqual([...resultA].sort(), [...expectedA].sort());

    const documentB = {
      paths: {},
      components: {
        schemas: {
          Orphan: {
            properties: {
              unreached: { $ref: "#/components/schemas/Unreached" },
            },
          },
          Unreached: { type: "object" },
        },
      },
    };
    const resultB = reachableSchemaNames(documentB);
    const expectedB: string[] = [];
    assert.deepEqual([...resultB].sort(), [...expectedB].sort());
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { createServer } from "node:http";
import pino from "pino";
import { decode } from "hono/jwt";
import { temporary } from "../kernel/test-support.ts";
import { gatewayFixture } from "./test-support.ts";
import { KANTHORD_AUTH_USERNAME } from "./local.ts";
import { Store } from "../kernel/store.ts";
import { configuration } from "./test-support.ts";
import { gatewayMigrations } from "./index.ts";
import { composeGateway } from "./test-support.ts";
import { CancellationContext } from "../kernel/context.ts";
import { isString } from "../kernel/values.ts";
import { HealthStatus } from "../kernel/service.ts";

test("concurrent starts share startup and restart preserves locally issued human JWTs without storing credentials", async (t) => {
  const path = join(temporary(t), "kanthord.db");
  const fixture = await gatewayFixture(t, { path });
  assert.equal(await fixture.gateway.stop(), null);
  fixture.store.close();
  const store = new Store(path);
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  const gateway = composeGateway({
    config: fixture.config,
    store,
    logger: pino({ enabled: false }),
  });
  t.after(async () => {
    await gateway.stop();
    await gateway.invocation.stop();
  });
  const start = gateway.start();
  assert.equal(start, gateway.start());
  assert.equal(await start, null);
  assert.deepEqual(
    await gateway.authentication.authenticate(`Bearer ${fixture.token}`),
    {
      kind: "human",
      accountId: KANTHORD_AUTH_USERNAME,
      name: KANTHORD_AUTH_USERNAME,
      jti: decode(fixture.token).payload.jti,
    },
  );
  assert.equal(
    store.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_account'")
      .get(),
    undefined,
  );
  assert.equal(await gateway.stop(), null);
});

test("a failed listener releases resources", async (t) => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => listener.close(() => resolve())),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  const gateway = composeGateway({
    store,
    config: configuration({
      masterKey: Buffer.alloc(32).toString("base64"),
      gateway: { port: address.port },
    }).getProperties(),
    logger: pino({ enabled: false }),
  });
  t.after(() => gateway.invocation.stop());
  assert.match((await gateway.start())!.message, /cannot bind/);
  assert.equal(gateway.address(), undefined);
  assert.equal(gateway.invocation.idempotency.healthcheck(), true);
  assert.equal(await gateway.stop(), null);
});

test("cancellation before and during gateway startup returns an error after releasing the listener", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  const config = configuration({
    masterKey: Buffer.alloc(32).toString("base64"),
    gateway: { port: 0 },
  }).getProperties();
  for (const before of [true, false]) {
    const context = new CancellationContext();
    const gateway = composeGateway({
      config,
      store,
      logger: pino({ enabled: false }),
    });
    t.after(() => gateway.invocation.stop());
    if (before) context.cancel();
    const running = gateway.run(context);
    if (!before) context.cancel();
    assert.ok((await running) instanceof Error);
    assert.equal(await gateway.stop(), null);
    assert.equal(gateway.address(), undefined);
    assert.ok(
      Object.values(await gateway.healthcheck()).every(
        (code) => code === HealthStatus.Unavailable,
      ),
    );
    assert.equal(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'gateway_account'",
        )
        .get(),
      undefined,
    );
  }
});

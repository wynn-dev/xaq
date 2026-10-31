import { createBrokerService } from "./broker/service.ts";
import type { Config } from "./config.ts";
import { upstreams } from "./broker/upstream/runtime.ts";
import { createCalendarService } from "./calendar/index.ts";
import { type AppContext, createCore, SERVICE_ORDER, type Services } from "./context.ts";
import { createEventsService } from "./events/index.ts";
import { createAccountsService, createGoogleService } from "./google/index.ts";
import { createIngestService } from "./ingest/index.ts";
import { createMailService } from "./mail/index.ts";
import { createPolicyService } from "./policy/index.ts";

/** Tests replace individual services with fakes. */
export type ServiceOverrides = Partial<{ [K in keyof Services]: (ctx: AppContext) => Services[K] }>;

const FACTORIES: { [K in keyof Services]: (ctx: AppContext) => Services[K] } = {
  accounts: createAccountsService,
  google: createGoogleService,
  ingest: createIngestService,
  events: createEventsService,
  policy: createPolicyService,
  mail: createMailService,
  calendar: createCalendarService,
  broker: (ctx) => createBrokerService(ctx),
};

/** Builds the full context. Nothing runs until `startServices`. */
export function createAppContext(config: Config, overrides: ServiceOverrides = {}): AppContext {
  const ctx = createCore(config) as AppContext;
  for (const key of SERVICE_ORDER) {
    const factory = (overrides[key] ?? FACTORIES[key]) as (ctx: AppContext) => never;
    (ctx as unknown as Record<string, unknown>)[key] = factory(ctx);
  }
  return ctx;
}

export async function startServices(ctx: AppContext): Promise<void> {
  for (const key of SERVICE_ORDER) await ctx[key].start?.();
  // The MCP broker's upstream sweep (proactive refresh, expiry warnings).
  upstreams(ctx).start();
}

/** Stops services in reverse order, then closes the database. Errors are logged, not thrown. */
export async function stopServices(ctx: AppContext): Promise<void> {
  for (const key of [...SERVICE_ORDER].reverse()) {
    try {
      await ctx[key].stop?.();
    } catch (err) {
      ctx.log.error(`Failed to stop ${key}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    await upstreams(ctx).stop();
  } catch (err) {
    ctx.log.error("Failed to stop the upstream runtime", { error: err instanceof Error ? err.message : String(err) });
  }
  ctx.db.close();
}

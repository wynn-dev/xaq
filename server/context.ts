// The application context: one object holding the core primitives and every service.
//
// Rules for services:
// - Each domain exposes `createXService(ctx: AppContext): XService` from `server/<domain>/index.ts`.
// - Factories may keep `ctx` but must NOT call other services while constructing: other members may
//   not exist yet. Cross-service calls happen at request time or after `start()`.
// - `start()` runs once everything is wired (in SERVICE_ORDER), `stop()` in reverse on shutdown.
// - Service contracts live in `server/<domain>/types.ts`. Members marked FROZEN there are relied on by
//   other domains.

import { AuditLog } from "./audit.ts";
import type { BrokerService } from "./broker/service.ts";
import { type Bus, createBus } from "./bus.ts";
import type { CalendarService } from "./calendar/types.ts";
import type { Config } from "./config.ts";
import { Crypto } from "./crypto.ts";
import { Db } from "./db/index.ts";
import type { EventsService } from "./events/types.ts";
import type { AccountsService, GoogleService } from "./google/types.ts";
import type { IngestService } from "./ingest/index.ts";
import type { MailService } from "./mail/types.ts";
import type { PolicyService } from "./policy/types.ts";
import { SettingsStore } from "./settings.ts";
import { createLogger, type Logger } from "./util/log.ts";

export interface Lifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface CoreContext {
  config: Config;
  db: Db;
  crypto: Crypto;
  log: Logger;
  bus: Bus;
  settings: SettingsStore;
  audit: AuditLog;
}

export interface Services {
  accounts: AccountsService;
  google: GoogleService;
  ingest: IngestService;
  events: EventsService;
  policy: PolicyService;
  mail: MailService;
  calendar: CalendarService;
  /** The MCP broker (server/broker/service.ts). */
  broker: BrokerService;
}

export interface AppContext extends CoreContext, Services {}

/** Start order. Policy and events first (no I/O), ingest and calendar sync last so everything they emit into is running. */
export const SERVICE_ORDER: (keyof Services)[] = ["policy", "accounts", "events", "mail", "google", "broker", "ingest", "calendar"];

export function createCore(config: Config): CoreContext {
  const db = new Db(config.dbPath);
  const bus = createBus();
  return {
    config,
    db,
    crypto: Crypto.load(config.masterKeyPath),
    log: createLogger(),
    bus,
    settings: new SettingsStore(db, bus, config),
    audit: new AuditLog(db, bus),
  };
}

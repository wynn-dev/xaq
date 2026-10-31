// The broker service's Connector over the upstream runtime (server/broker/upstream): probe, connect
// (static header, MCP OAuth, a native preset's own OAuth), the remote ToolSource and paste-mode finish.
// Also gives the runtime native presets' OAuth flows (generic `user_app`, from the preset's auth): done at
// construction, before start().

import type { Connection, ConnectionProbe } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { isGooglePreset, startGoogleConnect } from "../extensions/google-auth.ts";
import { errorMessage, HttpError } from "../util/errors.ts";
import { scrubText } from "./credentials/scrub.ts";
import type { ConnectOutcome, Connector } from "./service.ts";
import { type IntegrationPreset, type NativeSourceDeps, SourceError } from "./types.ts";
import { getConnection as upstreamConnection } from "./upstream/connection.ts";
import type { ProbeResult, UpstreamRuntime } from "./upstream/runtime.ts";
import { userAppFlow } from "./upstream/user-app.ts";

/** The runtime's probe in the console's words. */
export function toProbe(p: ProbeResult): ConnectionProbe {
  switch (p.auth) {
    case "none":
      return { reachable: true, auth: "none", message: "This server needs no sign-in." };
    case "header":
      return { reachable: true, auth: "header", message: "This server needs an API key or bearer token." };
    case "oauth":
      return {
        reachable: true,
        auth: "oauth",
        issuer: p.issuer,
        registration: p.registration === "pre_registered_required" ? "manual" : p.registration,
        refresh: p.refresh,
        message: `Sign-in through ${hostOf(p.issuer)}${p.registration === "pre_registered_required" ? "; paste a client ID registered there" : ""}.`,
      };
    case "blocked":
      return { reachable: false, auth: "unknown", blocked: p.privateTarget ? "private_target" : "ssrf", privateTarget: p.privateTarget, message: p.message };
    default:
      return { reachable: false, auth: "unknown", message: p.message };
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * Native presets' own OAuth: every `user_app` preset (a code extension's manifest `code.auth`, e.g. WHOOP) gets the
 * generic flow (server/broker/upstream/user-app.ts), resolved by preset id when a connection needs it.
 */
export function registerNativeFlows(up: UpstreamRuntime, presetFor: (id: string | null) => IntegrationPreset | null): void {
  up.setNativeFlowResolver((id) => {
    const p = presetFor(id);
    return p && p.kind === "native" && p.auth.type === "user_app" ? userAppFlow({ id: p.id, displayName: p.displayName, auth: p.auth }) : null;
  });
}

/** A native preset's source dependencies: fresh access tokens through the runtime's refresher. */
export function nativeDepsFor(ctx: AppContext, up: UpstreamRuntime, c: Connection): NativeSourceDeps {
  const log = ctx.log.child("broker");
  return {
    connectionId: c.id,
    accessToken: async (signal) => {
      const row = upstreamConnection(ctx.db, c.id);
      const refresh = row ? up.refreshFnFor(row) : null;
      if (!refresh) throw new SourceError("needs_reauth", `The owner must reconnect ${c.name} in xaq (Connections → Reconnect).`);
      return up.refresher.accessToken(c.id, refresh, signal);
    },
    tokenExpiresAt: () => up.store.tokens(c.id)?.expiresAt ?? null,
    fetch: globalThis.fetch,
    log: { info: (msg, meta) => log.info(msg, meta), warn: (msg, meta) => log.warn(msg, meta) },
  };
}

export function upstreamConnector(ctx: AppContext, up: UpstreamRuntime, presetFor: (id: string | null) => IntegrationPreset | null): Connector {
  const setAuth = (id: string, authType: "none" | "header" | "oauth", active: boolean) =>
    ctx.db.run(
      `UPDATE connections SET auth_type = ?, ${active ? "status = 'active', status_reason = NULL, " : ""}updated_at = ? WHERE id = ?`,
      authType,
      now(),
      id,
    );
  const failure = (err: unknown): ConnectOutcome => {
    if (err instanceof SourceError) return { status: "error", message: scrubText(err.message, [], 300) };
    throw err;
  };

  return {
    async probe({ url, privateTarget }, signal) {
      return toProbe(await up.probe(url, { privateTarget, signal }));
    },

    async startConnect(conn, input, signal) {
      try {
        const preset = presetFor(conn.preset);
        // Bound to an extension that isn't installed (yet): its tools keep working on the stored credential, but a new
        // sign-in waits for the extension's own rules (T3 Code's same-origin sign-in) instead of running generic ones.
        if (conn.preset && !preset) {
          return {
            status: "error",
            message: `The ${conn.preset} extension isn't installed yet, so ${conn.name} can't be reconnected. xaq installs it in the background; try again shortly, or install it from Extensions in the console.`,
          };
        }
        // A Google extension (official only): bind one of xaq's connected Google accounts, then its incremental consent
        // for the manifest's scopes, through the account OAuth client and callback (server/extensions/google-auth.ts).
        if (isGooglePreset(preset)) {
          if (input.header) throw new HttpError(400, "connection_auth", `${conn.name} doesn't take a header`);
          return startGoogleConnect(ctx, conn, preset, input, presetFor);
        }
        // Static header (bearer or API key): stored encrypted, injected per request.
        if (input.header) {
          if (conn.kind !== "remote_http") throw new HttpError(400, "connection_auth", `${conn.name} doesn't take a header`);
          up.store.setHeader(conn.id, input.header.name, input.header.value);
          setAuth(conn.id, "header", true);
          await up.invalidate(conn.id);
          return { status: "connected" };
        }
        // A native preset with the user's own app (WHOOP): store the pasted client, then its OAuth.
        if (preset?.auth.type === "user_app") {
          const a = preset.auth;
          const clientId = input.inputs?.[a.clientIdInput]?.trim();
          const secret = input.inputs?.[a.clientSecretInput];
          // A candidate only: saved with the tokens once the consent completes, so a typo can't break a working connection.
          const candidate =
            clientId || secret
              ? { ...(up.store.client(conn.id) ?? {}), ...(clientId ? { [a.clientIdInput]: clientId } : {}), ...(secret ? { [a.clientSecretInput]: secret } : {}) }
              : null;
          const r = await up.startConnect(conn.id, { reconnectPolicy: preset.reconnectPolicy, nativeClient: candidate });
          return { status: "authorize", authorizeUrl: r.authUrl, callbackMode: r.callbackMode, redirectUri: r.redirectUri };
        }
        if (conn.kind !== "remote_http" || !conn.url) throw new HttpError(400, "connection_kind", `${conn.name} has no sign-in flow`);
        if (conn.authType !== "oauth") {
          // Let the server say what it needs.
          const p = await up.probe(conn.url, { privateTarget: conn.privateTarget, signal });
          const probe = toProbe(p);
          if (p.auth === "none") {
            setAuth(conn.id, "none", true);
            await up.invalidate(conn.id);
            return { status: "connected" };
          }
          if (p.auth === "header") return { status: "error", message: "This server needs an API key or bearer token: connect with a header.", probe };
          if (p.auth !== "oauth") return { status: "error", message: probe.message, probe };
          setAuth(conn.id, "oauth", false);
        }
        const clientId = input.inputs?.client_id?.trim();
        const preRegistered = clientId ? { client_id: clientId, ...(input.inputs?.client_secret ? { client_secret: input.inputs.client_secret } : {}) } : null;
        const r = await up.startConnect(conn.id, { preRegistered, reconnectPolicy: preset?.reconnectPolicy, sameOriginIssuer: preset?.userServer?.sameOriginIssuer === true });
        return { status: "authorize", authorizeUrl: r.authUrl, callbackMode: r.callbackMode, redirectUri: r.redirectUri };
      } catch (err) {
        ctx.log.child("broker").warn("Starting a connection failed", { connection: conn.id, error: scrubText(errorMessage(err), [], 200) });
        return failure(err);
      }
    },

    async finishFromUrl(raw) {
      try {
        const done = await up.finishConnectFromUrl(raw);
        return { status: "connected", connectionId: done.connectionId };
      } catch (err) {
        const f = failure(err);
        return { ...(f as { status: "error"; message: string }), connectionId: null };
      }
    },

    createSource: (c) => up.source(c.id),
    invalidate: (id) => up.invalidate(id),
    disconnect: (id) => up.disconnect(id),
  };
}

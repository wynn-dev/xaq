import { callbackPage } from "../../api/oauth.ts";
import { router } from "../../api/util.ts";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../util/errors.ts";
import { scrubText } from "../credentials/scrub.ts";
import { SourceError } from "../types.ts";
import { CLIENT_METADATA_PATH, CONNECTION_CALLBACK_PATH, upstreams } from "./runtime.ts";

/**
 * GET /oauth/connections/callback (unauthenticated, like Google's /oauth/callback, which it leaves alone):
 * finishes an upstream connection's sign-in and renders the shared result page, posting an
 * `agentinbox:connection-oauth` message to the console. GET /oauth/connections/client.json serves the client
 * ID metadata document.
 */
export function connectionOAuthRoutes(ctx: AppContext) {
  const r = router();

  r.get(CONNECTION_CALLBACK_PATH, async (c) => {
    const rt = upstreams(ctx);
    const targetOrigin = ctx.config.dev ? "*" : new URL(ctx.settings.publicUrl()).origin;
    const q = new URL(c.req.url).searchParams;
    try {
      const done = await rt.finishConnect({ code: q.get("code"), state: q.get("state"), iss: q.get("iss"), error: q.get("error"), errorDescription: q.get("error_description") });
      // The broker re-lists the connection's tools with the new credential.
      ctx.broker.invalidate({ connectionId: done.connectionId });
      ctx.broker.attach(done.connectionId);
      return c.html(
        callbackPage({
          ok: true,
          connection: { id: done.connectionId, name: done.name },
          title: `${done.name} connected`,
          message: `Connected ${done.name}. You can close this tab.`,
          targetOrigin,
        }),
      );
    } catch (err) {
      const known = err instanceof HttpError;
      const source = err instanceof SourceError ? err : null;
      ctx.log.child("broker").warn("Connection sign-in failed", { code: known ? err.code : (source?.code ?? "internal") });
      const message = known ? err.message : source ? scrubText(source.message, [], 300) : "Something went wrong while finishing the connection.";
      return c.html(
        callbackPage({
          ok: false,
          connection: { id: null, name: null },
          title: known && err.code === "oauth_access_denied" ? "Connection cancelled" : "Couldn't connect",
          message,
          hint: known ? (err.hint ?? null) : "Try again from Connections in the console. If it keeps failing, check the xaq server log.",
          code: known ? err.code : source ? `connection_${source.code}` : "internal",
          targetOrigin,
        }),
        known && err.status < 500 ? 400 : source ? 502 : 500,
      );
    }
  });

  r.get(CLIENT_METADATA_PATH, (c) => {
    const rt = upstreams(ctx);
    if (!ctx.settings.publicUrl().startsWith("https://")) return c.notFound();
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(rt.clientMetadataDocument());
  });

  return r;
}

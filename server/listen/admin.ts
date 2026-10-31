import pc from "picocolors";
import { ApiError, getSelf } from "./api.ts";
import { describeGrants, hasAccess } from "./grants.ts";
import { outputLine } from "./listen.ts";
import { describeFilter, resolveListen } from "./options.ts";
import { logPath, profilePath } from "./paths.ts";
import { loadProfile } from "./profile.ts";
import { installedServiceLabel } from "./service.ts";
import { pidAlive, readStatus } from "./state.ts";
import { checkTransport, TransportError } from "./transport.ts";
import { formatDuration, safeText } from "./ui.ts";
import { NPX } from "./version.ts";

const out = (s = "") => process.stdout.write(`${s}\n`);
const ago = (iso: string | null | undefined) => (iso ? `${formatDuration(Date.now() - Date.parse(iso))} ago` : "never");

/** `listen status`: the pairing, the saved settings, the service, the key's access and the last run. */
export async function printStatus(): Promise<void> {
  const profile = loadProfile();
  const st = readStatus();
  const alive = st ? pidAlive(st.pid) && !st.stoppedAt : false;

  out(`${pc.bold("Profile")}   ${pc.gray(profilePath())}`);
  out(`${pc.bold("Agent")}     ${safeText(profile.agentName)} ${pc.gray(`(${profile.agentId})`)}`);
  out(`${pc.bold("Daemon")}    ${profile.url}`);
  out(`${pc.bold("Consumer")}  ${st?.consumer ?? profile.consumer}`);
  // What the running listener uses (flags included), else the saved settings.
  const saved = resolveListen(profile, {}).config;
  const exec = alive && st?.exec !== undefined ? st.exec : saved.exec;
  out(`${pc.bold("Runs")}      ${exec ? `exec ${safeText(exec, 120)}` : pc.gray("nothing saved (`listen service install --recipe claude-code` saves it)")}`);
  out(`${pc.bold("Events")}    ${(alive && st?.filters) || describeFilter(saved)}`);
  out(`${pc.bold("Output")}    ${outputLine(exec ?? null, logPath())}`);

  let svc = "not installed";
  if (process.platform === "linux" || process.platform === "darwin") {
    const installed = installedServiceLabel();
    if (installed) svc = `installed (${installed}; details: ${NPX} listen service status)`;
  }
  out(`${pc.bold("Service")}   ${svc}`);

  try {
    // Never send the key over a connection `listen` itself would refuse.
    await checkTransport(profile.url, { insecure: profile.insecure });
    const self = await getSelf(profile.url, profile.apiKey, 5000);
    out(`${pc.bold("Key")}       ${pc.green("valid")}`);
    // The access the console actually granted, in plain words (what the agent should report to its human).
    const lines = describeGrants(self.grants, self.connections);
    out(`${pc.bold("Access")}    ${hasAccess(self) ? lines[0] : pc.yellow(lines[0]!)}`);
    for (const l of lines.slice(1)) out(`          ${l}`);
  } catch (err) {
    const revoked = err instanceof ApiError && (err.status === 401 || err.status === 403);
    const why = err instanceof ApiError && err.status === 0 ? (err.cause as string) : err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (err instanceof TransportError) out(`${pc.bold("Key")}       ${pc.red(`not checked: ${why}`)}`);
    else out(`${pc.bold("Key")}       ${revoked ? pc.red(`rejected: ${(err as Error).message}`) : pc.yellow(`not checked (${why})`)}`);
  }

  if (!st) {
    out(`${pc.bold("Listener")}  ${pc.gray("has not run yet")}`);
  } else {
    const state = !alive
      ? pc.gray(`not running${st.stoppedAt ? ` (stopped ${ago(st.stoppedAt)}${st.exitReason ? `: ${safeText(st.exitReason, 160)}` : ""})` : " (exited unexpectedly)"}`)
      : st.connected
        ? pc.green(`running (pid ${st.pid}), connected ${ago(st.connectedSince)}`)
        : pc.yellow(`running (pid ${st.pid}), disconnected${st.lastDisconnect ? ` ${ago(st.lastDisconnect.at)}: ${safeText(st.lastDisconnect.reason, 160)}` : ""}`);
    out(`${pc.bold("Listener")}  ${state}`);
    out(
      `${pc.bold("Cursor")}    acked #${st.ackedSeq} · received #${st.receivedSeq}${alive && st.running ? ` · ${st.running} in progress` : ""}${st.skipped ? ` · ${st.skipped} skipped by filters` : ""} · last event ${ago(st.lastEventAt)}`,
    );
    if (st.recent.length) {
      out(pc.bold("Recent"));
      for (const r of st.recent.slice(0, 8)) {
        const icon = r.outcome === "succeeded" ? pc.green("✓") : r.outcome === "failed" ? pc.red("✖") : r.outcome === "retrying" ? pc.yellow("↻") : pc.gray("·");
        out(`  ${icon} #${r.seq} ${r.type} ${pc.gray(`${ago(r.at)}${r.attempts > 1 ? `, ${r.attempts} attempts` : ""}${r.error && r.outcome !== "succeeded" ? `, ${safeText(r.error, 100)}` : ""}`)}`);
      }
    }
  }
  out(`${pc.bold("Log")}       ${logPath()}`);
}

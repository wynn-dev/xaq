// Access tokens xaq handed to a connection's code extension that live in no credential store (a Google extension's
// downscoped tokens, server/extensions/google-auth.ts): the last few per connection, in memory, so tool output that
// echoes one is scrubbed like a stored credential (server/broker/policy/output.ts connectionSecrets). No imports.

const handed = new Map<string, string[]>();
const KEEP = 4;

export function rememberHandedToken(connectionId: string, token: string): void {
  const list = (handed.get(connectionId) ?? []).filter((t) => t !== token);
  list.push(token);
  handed.set(connectionId, list.slice(-KEEP));
}

/** The tokens recently handed to this connection's extension. */
export function handedTokens(connectionId: string): string[] {
  return [...(handed.get(connectionId) ?? [])];
}

/** Forgets a connection's tokens (it was removed or killed). */
export function forgetHandedTokens(connectionId: string): void {
  handed.delete(connectionId);
}

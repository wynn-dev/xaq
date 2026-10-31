// The public URL's rules, checked by the server (server/settings.ts) and shown by the console before saving.

/** What's wrong with a public URL, or undefined when it's a full http(s) URL without a query or fragment. */
export function publicUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full URL, e.g. https://mail.example.com or http://localhost:8425.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http or https.";
  if (url.search || url.hash) return "Leave out any ?query or #fragment.";
  return undefined;
}

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useStreamListener } from "@/lib/stream";

/** How many components that show pending requests inline (PendingPairings) are mounted right now. */
let inlineViews = 0;

/** Mount in a component that shows pending pairing requests itself: no toast while it is on screen. */
export function useSilencePairingToasts() {
  useEffect(() => {
    inlineViews++;
    return () => void inlineViews--;
  }, []);
}

/** Toasts once per new pairing request, unless the approvals page or an inline list of requests is open. */
export function PairingNotifier() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const seen = useRef(new Set<string>());
  useStreamListener((msg) => {
    if (msg.kind !== "pairing" || msg.data.status !== "pending" || seen.current.has(msg.data.id)) return;
    seen.current.add(msg.data.id);
    if (pathname.startsWith("/approvals") || inlineViews > 0) return;
    toast(`${msg.data.name} is asking for access`, {
      description: msg.data.client.hostname ? `From ${msg.data.client.hostname}. Approve it with the code in its terminal.` : "Approve it with the code in its terminal.",
      duration: 15_000,
      action: { label: "Review", onClick: () => void navigate({ to: "/approvals" }) },
    });
  });
  return null;
}

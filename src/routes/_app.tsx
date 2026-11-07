import { useQueryClient } from "@tanstack/react-query";
import { Outlet, createFileRoute, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { ConnectAccountHost } from "@/components/accounts/connect-host";
import { AppSidebar } from "@/components/app-sidebar";
import { CalendarSetupHost } from "@/components/google/calendar-setup";
import { AddConnectionHost } from "@/components/connections/add-connection";
import { ConnectionAuthHost } from "@/components/connections/connection-auth";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { PairingNotifier } from "@/components/pairing-notifier";
import { ThemeToggle } from "@/components/theme";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { UNAUTHORIZED_EVENT } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { forgetAllKeys } from "@/lib/revealed-keys";
import { StreamProvider } from "@/lib/stream";

export const Route = createFileRoute("/_app")({
  // A loader, not beforeLoad: the router waits for beforeLoad before it fetches any page code, while loaders run
  // alongside it, so on a first load the code downloads during this request instead of after it.
  loader: async ({ context, location }) => {
    // Cached briefly so in-app navigation doesn't hit the server each time; a 401 anywhere
    // sends the user to /login regardless.
    const status = await context.queryClient.fetchQuery({ ...queries.setupStatus(), staleTime: 60_000 });
    if (!status.claimed) throw redirect({ to: "/setup" });
    if (!status.authenticated) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.href });

  useEffect(() => {
    const onUnauthorized = () => {
      forgetAllKeys();
      qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: false });
      void navigate({ to: "/login", search: { redirect: href } });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, qc, href]);

  return (
    <StreamProvider>
      {/* Tablets get the sidebar collapsed (it's a toggle away), so content isn't squeezed. */}
      <SidebarProvider defaultOpen={window.matchMedia("(min-width: 1024px)").matches}>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
        >
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/80 px-4 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            <div className="flex-1" />
            <ConnectionIndicator />
            <ThemeToggle />
          </header>
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl min-w-0 flex-1 space-y-6 p-4 outline-none md:p-6 lg:p-8">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <ConnectAccountHost />
      <CalendarSetupHost />
      <AddConnectionHost />
      <ConnectionAuthHost />
      <PairingNotifier />
    </StreamProvider>
  );
}

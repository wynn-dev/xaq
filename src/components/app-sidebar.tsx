import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ActivityIcon,
  BotIcon,
  InboxIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MailIcon,
  PlugIcon,
  PuzzleIcon,
  RocketIcon,
  ScrollTextIcon,
  SettingsIcon,
  StampIcon,
} from "lucide-react";
import { Logo } from "@/components/auth-shell";
import { ConsoleVersion } from "@/components/console-update";
import { showsSetupLink, useSetupProgress } from "@/components/setup/progress";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSignOut } from "@/hooks/use-sign-out";
import { queries } from "@/lib/queries";

type NavItem = {
  to: "/" | "/approvals" | "/events" | "/audit" | "/accounts" | "/connections" | "/extensions" | "/agents" | "/settings";
  label: string;
  icon: typeof InboxIcon;
};

const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Monitor",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboardIcon },
      { to: "/approvals", label: "Approvals", icon: StampIcon },
      { to: "/events", label: "Live events", icon: ActivityIcon },
      { to: "/audit", label: "Audit log", icon: ScrollTextIcon },
    ],
  },
  {
    label: "Manage",
    items: [
      { to: "/accounts", label: "Gmail accounts", icon: MailIcon },
      { to: "/connections", label: "Connections", icon: PlugIcon },
      { to: "/extensions", label: "Extensions", icon: PuzzleIcon },
      { to: "/agents", label: "Agents", icon: BotIcon },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

export function AppSidebar() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  const { data: pending } = useQuery(queries.approvals("pending"));
  const { data: system } = useQuery(queries.system());
  const setup = useSetupProgress();
  const { data: pairings } = useQuery(queries.pairings("pending"));
  const pendingCount = (pending?.length ?? 0) + (pairings?.length ?? 0);

  const signOut = useSignOut();

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" onClick={close}>
                <Logo className="size-8 shrink-0" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">xaq</span>
                  <span className="truncate text-xs text-muted-foreground">Gmail for your agents</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Stays while the wizard is open, even once everything is green: it goes on navigating away. */}
        {showsSetupLink(!!setup.state, setup.allDone, pathname) && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Get started" isActive={pathname.startsWith("/get-started")}>
                    <Link to="/get-started" onClick={close}>
                      <RocketIcon />
                      <span>Get started</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="tabular">
                    {setup.finished}/{setup.total}
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.label}
                      isActive={item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)}
                    >
                      <Link to={item.to} onClick={close}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.to === "/approvals" && pendingCount > 0 && (
                      <SidebarMenuBadge className="rounded-full bg-warning/20 px-1.5 text-foreground tabular" aria-label={`${pendingCount} pending`}>
                        {pendingCount}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Sign out" onClick={signOut}>
              <LogOutIcon />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <ConsoleVersion version={system?.version} service={system?.service} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

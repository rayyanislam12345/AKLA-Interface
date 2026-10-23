import { FolderKanban, Users, ListTree, BookMarked, Megaphone, MessageCircle, HelpCircle, LogOut, Mic, Clock, Scale, Sparkles, Settings, type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile, usePendingProfiles, type AppRole } from "@/hooks/useProfiles";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import aklaLogo from "@/assets/akla-logo.png";
import aklaMonogram from "@/assets/akla-monogram.png";

// Exported so the Help page describes the sidebar people actually see.
// What every associate does day to day. The AI is used from Claude through
// the firm's connector; "Use with Claude" is how to set that up.
export const NAV_ITEMS: { title: string; url: string; icon: LucideIcon }[] = [
  { title: "Projects", url: "/matters", icon: FolderKanban },
  { title: "Record Meeting", url: "/record-meeting", icon: Mic },
  { title: "Timesheet", url: "/timesheet", icon: Clock },
  { title: "Firm Library", url: "/precedent-library", icon: BookMarked },
  { title: "Case-Law Research", url: "/caselaw-research", icon: Scale },
  { title: "Use with Claude", url: "/claude", icon: Sparkles },
  { title: "Help", url: "/help", icon: HelpCircle },
];

const ADMIN_ROLES: AppRole[] = ["admin", "founder"];

// Running the firm rather than doing the work: shown only to the roles
// named. Every page stays at its address; only the sidebar entry is hidden.
export const FIRM_NAV_ITEMS: { title: string; url: string; icon: LucideIcon; roles: AppRole[] }[] = [
  { title: "Team", url: "/team", icon: Users, roles: ADMIN_ROLES },
  { title: "Document Types", url: "/document-types", icon: ListTree, roles: ADMIN_ROLES },
  { title: "Mandate Opportunities", url: "/mandate-opportunities", icon: Megaphone, roles: [...ADMIN_ROLES, "partner", "senior_counsel"] },
  { title: "WhatsApp Activity", url: "/whatsapp-activity", icon: MessageCircle, roles: ADMIN_ROLES },
];

export function AppSidebar() {
  const { state, isMobile } = useSidebar();
  const { user, signOut } = useAuth();
  const location = useLocation();
  const { data: me } = useMyProfile();
  const firmItems = FIRM_NAV_ITEMS.filter((item) => !!me?.role && item.roles.includes(me.role));
  const isAdmin = !!me?.role && ADMIN_ROLES.includes(me.role);
  // Zero rows for anyone but an administrator (the profiles policy).
  const { data: pending } = usePendingProfiles();
  const pendingCount = isAdmin ? pending?.length ?? 0 : 0;
  // On mobile the sidebar always renders full-width inside a Sheet (see
  // ui/sidebar.tsx) regardless of `state` — `state` only tracks the desktop
  // hover-to-expand behavior below, and never flips to "expanded" from a
  // mobile toggle. Without this, the mobile drawer opened at full width but
  // still rendered icon-only with no labels, looking oversized for what it
  // actually showed.
  const isCollapsed = !isMobile && state === "collapsed";

  const getInitials = (email: string) => {
    const name = email.split("@")[0];
    const parts = name.split(/[._-]/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <Sidebar
      className="border-r-0 bg-sidebar"
      collapsible="icon"
    >
      <SidebarHeader className="border-b border-white/10 h-14 flex items-center px-4">
        <div className="flex items-center justify-center w-full">
          {isCollapsed ? (
            <img
              src={aklaMonogram}
              alt="AKLA"
              className="h-9 w-9 shrink-0 rounded-full object-cover"
            />
          ) : (
            <img src={aklaLogo} alt="Ali Khan Law Associates" className="h-8 w-auto max-w-full object-contain" />
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-white/60 text-xs uppercase px-4 py-2">
            {!isCollapsed && "Navigation"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <NavItem key={item.url} {...item} pathname={location.pathname} collapsed={isCollapsed} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {firmItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-white/60 text-xs uppercase px-4 py-2">
              {!isCollapsed && "Firm"}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {firmItems.map((item) => (
                  <NavItem
                    key={item.url}
                    {...item}
                    pathname={location.pathname}
                    collapsed={isCollapsed}
                    badge={item.url === "/team" && pendingCount > 0 ? pendingCount : undefined}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-white/10 p-4">
        {user && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Avatar className="w-8 h-8">
                <AvatarFallback className="bg-accent/20 text-accent text-sm font-medium">
                  {getInitials(user.email || "")}
                </AvatarFallback>
              </Avatar>
              {!isCollapsed && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{user.email}</p>
                </div>
              )}
            </div>
            {!isCollapsed && (
              <Button
                asChild
                variant="ghost"
                size="sm"
                className={`w-full justify-start hover:bg-white/10 hover:text-white ${
                  location.pathname === "/settings" ? "text-accent" : "text-white"
                }`}
              >
                <NavLink to="/settings">
                  <Settings className="w-4 h-4 mr-2" />
                  Settings
                </NavLink>
              </Button>
            )}
            {!isCollapsed && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => signOut()}
                className="w-full justify-start text-white hover:bg-white/10 hover:text-white"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign Out
              </Button>
            )}
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

function NavItem({ title, url, icon: Icon, pathname, collapsed, badge }: {
  title: string;
  url: string;
  icon: LucideIcon;
  pathname: string;
  collapsed: boolean;
  /** A count beside the label, e.g. sign-ups waiting for approval. */
  badge?: number;
}) {
  // Mirror NavLink's own default matching (exact, or a child route)
  // instead of NavLink's function-typed className prop: SidebarMenuButton's
  // asChild wraps a Radix Slot, which merges className via plain string
  // concatenation. A function passed as className gets silently coerced to
  // its own source text via that concatenation, so the isActive styling
  // never actually applied — every row rendered identically. Precomputing
  // isActive here and passing a plain string sidesteps that incompatibility.
  const isActive = pathname === url || pathname.startsWith(`${url}/`);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild className="hover:bg-white/10">
        <NavLink
          to={url}
          title={badge ? `${title}: ${badge} waiting for approval` : undefined}
          className={`relative flex items-center border-l-2 py-2 transition-colors ${
            collapsed ? "justify-center px-2" : "gap-3 px-4"
          } ${isActive ? "border-accent bg-white/10 text-accent font-medium" : "border-transparent text-white"}`}
        >
          <Icon className="!h-6 !w-6 shrink-0" />
          {!collapsed && <span>{title}</span>}
          {badge ? (
            <span
              className={`rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-foreground ${
                collapsed ? "absolute right-1 top-1" : "ml-auto"
              }`}
            >
              {badge}
            </span>
          ) : null}
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

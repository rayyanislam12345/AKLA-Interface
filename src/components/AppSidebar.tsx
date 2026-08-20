import { LayoutDashboard, FolderKanban, Building2, Users, ListTree, BookMarked, HelpCircle, LogOut } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
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

const NAV_ITEMS = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Matters", url: "/matters", icon: FolderKanban },
  { title: "Clients", url: "/clients", icon: Building2 },
  { title: "Team", url: "/team", icon: Users },
  { title: "Precedent Library", url: "/precedent-library", icon: BookMarked },
  { title: "Document Types", url: "/document-types", icon: ListTree },
  { title: "Help", url: "/help", icon: HelpCircle },
];

export function AppSidebar() {
  const { state, setOpen } = useSidebar();
  const { user, signOut } = useAuth();
  const isCollapsed = state === "collapsed";

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
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
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
              {NAV_ITEMS.map(({ title, url, icon: Icon }) => (
                <SidebarMenuItem key={title}>
                  <SidebarMenuButton asChild className="hover:bg-white/10">
                    <NavLink
                      to={url}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-4 py-2 border-l-2 transition-colors ${
                          isActive
                            ? "border-accent bg-white/10 text-accent font-medium"
                            : "border-transparent text-white"
                        }`
                      }
                    >
                      <Icon className="h-5 w-5" />
                      {!isCollapsed && <span>{title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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

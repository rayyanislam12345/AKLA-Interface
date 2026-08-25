import { ReactNode } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useActivityTracking } from "@/hooks/useActivityTracking";
import { AppSidebar } from "@/components/AppSidebar";

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  useActivityTracking();

  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex-1 flex flex-col">
          <header className="h-14 border-b border-sidebar-border bg-sidebar flex items-center gap-3 px-4 md:px-6">
            <SidebarTrigger className="text-white hover:bg-white/10 hover:text-white md:hidden" />
            <span className="text-lg font-semibold text-white tracking-tight">
              <span className="text-accent">AKLA</span> Matter Hub
            </span>
          </header>
          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

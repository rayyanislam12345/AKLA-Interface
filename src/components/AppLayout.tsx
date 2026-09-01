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
        {/* min-w-0 overrides the flex default of min-width:auto — without it,
            this column refuses to shrink below its content's intrinsic width
            (a table, unbreakable text) and grows past the viewport instead of
            letting that content wrap/clip within its own container. */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-14 border-b border-sidebar-border bg-sidebar flex items-center gap-3 px-4 md:px-6">
            <SidebarTrigger className="text-white hover:bg-white/10 hover:text-white md:hidden" />
            <span className="text-lg font-semibold text-white tracking-tight">
              <span className="text-accent">AKLA</span> Matter Hub
            </span>
          </header>
          <main className="flex-1 min-w-0 p-4 md:p-6 overflow-x-hidden">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

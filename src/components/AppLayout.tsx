import { ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
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
          <header
            className="h-14 border-b flex items-center px-6"
            style={{ backgroundColor: "#132050" }}
          >
            <span className="text-lg font-semibold text-white tracking-tight">
              AKLA Matter Hub
            </span>
          </header>
          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

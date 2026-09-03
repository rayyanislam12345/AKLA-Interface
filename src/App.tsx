import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import MattersPage from "./pages/MattersPage";
import MatterWorkspacePage from "./pages/MatterWorkspacePage";
import AiWorkspacePage from "./pages/AiWorkspacePage";
import RecordMeetingPage from "./pages/RecordMeetingPage";
import DocumentTypesPage from "./pages/DocumentTypesPage";
import PrecedentLibraryPage from "./pages/PrecedentLibraryPage";
import StandardizeDocumentTypePage from "./pages/StandardizeDocumentTypePage";
import MandateOpportunitiesPage from "./pages/MandateOpportunitiesPage";
import WhatsAppActivityPage from "./pages/WhatsAppActivityPage";
import ClientsPage from "./pages/ClientsPage";
import TodaysTimesheetPage from "./pages/TodaysTimesheetPage";
import TeamPage from "./pages/TeamPage";
import HelpPage from "./pages/HelpPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Ask AI, Draft with AI and Review with AI used to be three pages; they're
// now tabs of the AI Workspace. Old URLs (bookmarks, in-flight sessions)
// land on the right tab — and, for a review, the right document.
function RedirectToAiWorkspace({ mode }: { mode: "ask" | "draft" | "verify" }) {
  const { matterId, matterDocumentId } = useParams<{ matterId: string; matterDocumentId?: string }>();
  const params = new URLSearchParams({ mode });
  if (mode === "verify" && matterDocumentId) params.set("doc", matterDocumentId);
  return <Navigate to={`/matters/${matterId}/ai?${params.toString()}`} replace />;
}

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/auth" element={<Auth />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route
                  path="/dashboard"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <Dashboard />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/matters"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <MattersPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/matters/:matterId"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <MatterWorkspacePage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/matters/:matterId/ai"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <AiWorkspacePage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route path="/matters/:matterId/chat" element={<RedirectToAiWorkspace mode="ask" />} />
                <Route path="/matters/:matterId/draft" element={<RedirectToAiWorkspace mode="draft" />} />
                <Route
                  path="/matters/:matterId/documents/:matterDocumentId/review"
                  element={<RedirectToAiWorkspace mode="verify" />}
                />
                <Route
                  path="/timesheet"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <TodaysTimesheetPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/record-meeting"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <RecordMeetingPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/precedent-library"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <PrecedentLibraryPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/precedent-library/standardize/:documentTypeId"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <StandardizeDocumentTypePage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/mandate-opportunities"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <MandateOpportunitiesPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/whatsapp-activity"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <WhatsAppActivityPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/document-types"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <DocumentTypesPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/clients"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <ClientsPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/team"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <TeamPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/help"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <HelpPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};

export default App;

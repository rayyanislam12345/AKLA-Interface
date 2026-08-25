import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import MattersPage from "./pages/MattersPage";
import MatterWorkspacePage from "./pages/MatterWorkspacePage";
import DraftDocumentPage from "./pages/DraftDocumentPage";
import RedlineReviewPage from "./pages/RedlineReviewPage";
import MatterChatPage from "./pages/MatterChatPage";
import DocumentTypesPage from "./pages/DocumentTypesPage";
import PrecedentLibraryPage from "./pages/PrecedentLibraryPage";
import MandateOpportunitiesPage from "./pages/MandateOpportunitiesPage";
import WhatsAppActivityPage from "./pages/WhatsAppActivityPage";
import ClientsPage from "./pages/ClientsPage";
import TeamPage from "./pages/TeamPage";
import HelpPage from "./pages/HelpPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

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
                  path="/matters/:matterId/draft"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <DraftDocumentPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/matters/:matterId/documents/:matterDocumentId/review"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <RedlineReviewPage />
                      </AppLayout>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/matters/:matterId/chat"
                  element={
                    <ProtectedRoute>
                      <AppLayout>
                        <MatterChatPage />
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

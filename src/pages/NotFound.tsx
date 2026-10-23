import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";

// A stale or mistyped link lands inside the app — sidebar and all — with one
// clear way back, instead of a bare page that reloads everything.
const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.warn("No page at", location.pathname);
  }, [location.pathname]);

  return (
    <ProtectedRoute>
      <AppLayout>
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center" data-testid="not-found">
          <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">This page doesn't exist</h1>
            <p className="text-muted-foreground">
              The link may be out of date, or the page may have moved. Everything else is where you left it.
            </p>
          </div>
          <Button asChild>
            <Link to="/matters">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to your projects
            </Link>
          </Button>
        </div>
      </AppLayout>
    </ProtectedRoute>
  );
};

export default NotFound;

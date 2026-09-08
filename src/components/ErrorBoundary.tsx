import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// React unmounts the entire tree when a render throws, so without this the
// app goes completely white and the associate has no idea what happened or
// what to do — which is exactly how a single bad reference in one project's
// header took out the whole workspace page. This keeps the failure local:
// the error is named, the rest of the app is still reachable, and there is a
// way back that doesn't involve knowing to open devtools.
interface Props {
  children: ReactNode;
  // Changing this resets the boundary — navigation shouldn't stay broken
  // after the page that failed has been left behind.
  resetKey?: string;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="max-w-lg">
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div className="space-y-1">
                <h2 className="font-semibold">This page couldn't be displayed</h2>
                <p className="text-sm text-muted-foreground">
                  Something went wrong rendering this screen. Nothing you were working on has been deleted — reloading
                  usually clears it. If it keeps happening, send this message to whoever maintains the app.
                </p>
              </div>
            </div>
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {error.message}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => window.location.reload()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Reload
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  this.setState({ error: null });
                  this.props.onReset?.();
                }}
              >
                Back to dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}

// Resets itself whenever the route changes, so one broken page doesn't
// wedge the whole session.
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <ErrorBoundary resetKey={location.pathname + location.search} onReset={() => navigate("/dashboard")}>
      {children}
    </ErrorBoundary>
  );
}

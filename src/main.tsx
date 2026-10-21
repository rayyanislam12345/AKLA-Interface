import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initTelemetry } from "./lib/telemetry";
import { isFramed, resolveCompanionHost, resolveEmbedMode } from "./lib/embedMode";
import { pushAsReplace } from "./lib/companionHistory";

// Error tracking and analytics start first so an error during startup is
// caught too; both are no-ops until their keys are set (see lib/telemetry.ts).
void initTelemetry();

// In the companion's drawer, pages opened in the Hub must not pile into the
// claude.ai tab's Back (src/lib/companionHistory.ts). Before the router mounts.
if (resolveEmbedMode() && resolveCompanionHost() && isFramed()) pushAsReplace(window.history);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error('Failed to find the root element');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

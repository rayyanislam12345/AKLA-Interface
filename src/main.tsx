import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initTelemetry } from "./lib/telemetry";

// Error tracking and analytics start first so an error during startup is
// caught too; both are no-ops until their keys are set (see lib/telemetry.ts).
void initTelemetry();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error('Failed to find the root element');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

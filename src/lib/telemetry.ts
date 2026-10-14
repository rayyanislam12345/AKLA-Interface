// Error tracking and usage analytics, the Phase 0 instrumentation.
//
// Until now the firm learned about breakage from complaints and had no idea
// which features associates used or abandoned. Both SDKs load only when
// their key is set, and by dynamic import, so an unconfigured build pays
// nothing in bundle size and nothing at runtime.
//
// What is sent: Sentry gets unhandled errors and failed promises with a stack
// trace and the page they happened on; PostHog gets page views and the
// `track()` events below. Neither gets document contents, chat text or
// client names — only feature names and counts.

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://eu.i.posthog.com";

type Props = Record<string, string | number | boolean | null | undefined>;
let posthog: null | { capture: (event: string, props?: Props) => void; identify: (id: string, props?: Props) => void; reset: () => void } = null;

export async function initTelemetry() {
  if (SENTRY_DSN) {
    const Sentry = await import("@sentry/react");
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: import.meta.env.MODE,
      // Errors only: no session replay and no performance tracing, which
      // would capture screen contents the firm has not agreed to send.
      // (Personal data is off by Sentry's default; nothing here turns it on.)
      tracesSampleRate: 0,
    });
  }
  if (POSTHOG_KEY) {
    const mod = await import("posthog-js");
    const ph = mod.default;
    ph.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      autocapture: false, // only the events this app names, never arbitrary clicks or input
      disable_session_recording: true,
      person_profiles: "identified_only",
    });
    posthog = ph;
  }
}

// Name a thing an associate did: track("draft.started", { documentType: "…" }).
// Safe to call before init or when analytics is off; it just does nothing.
export function track(event: string, props?: Props) {
  posthog?.capture(event, props);
}

// Tie events to a user id (never an email or name) after sign-in, and clear on sign-out.
export function identifyUser(id: string | null) {
  if (!posthog) return;
  if (id) posthog.identify(id);
  else posthog.reset();
}

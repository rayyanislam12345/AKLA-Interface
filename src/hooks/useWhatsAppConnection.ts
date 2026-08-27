import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// In dev, Vite's own proxy (vite.config.ts) forwards /whatsapp-api to
// localhost:3740 for free. In production there's no dev server to proxy
// through, so this needs whatsapp-dashboard's real public URL (its own
// DigitalOcean droplet, behind Caddy/HTTPS at a DuckDNS hostname) instead
// — set via VITE_WHATSAPP_API_URL.
const WHATSAPP_API_BASE =
  (import.meta.env.VITE_WHATSAPP_API_URL as string | undefined)?.replace(/\/$/, "") || "/whatsapp-api";

async function whatsappApiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const res = await fetch(`${WHATSAPP_API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...options.headers,
    },
  });
  return res;
}

export interface WhatsAppStatus {
  state: "starting" | "qr" | "ready" | "disconnected" | "not_linked" | string;
  qr: string | null;
}

export function useWhatsAppStatus() {
  return useQuery({
    queryKey: ["whatsapp-connection-status"],
    queryFn: async (): Promise<WhatsAppStatus> => {
      const res = await whatsappApiFetch("/status");
      // A 401 here specifically means no whatsapp_account_links row maps
      // the current firm member to a whatsapp-dashboard account — the
      // React app never uses the old username/password login, so this is
      // unambiguous rather than a generic auth failure.
      if (res.status === 401) return { state: "not_linked", qr: null };
      if (!res.ok) throw new Error("Failed to load WhatsApp connection status");
      return res.json();
    },
    refetchInterval: 10000,
  });
}

// Self-service linking: creates a whatsapp-dashboard account for the
// current firm member on the spot (keyed on their own Supabase profile id)
// and kicks off a fresh WhatsApp session — the subsequent /status polls
// pick up "qr" once wppconnect generates one. No admin action needed.
export function useLinkMyWhatsApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await whatsappApiFetch("/supabase-link", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to link WhatsApp");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connection-status"] });
    },
  });
}

export interface BackfillStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  chats: { chat: string; processed?: number; error?: string }[];
}

export function useBackfillStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-backfill-status"],
    queryFn: async (): Promise<BackfillStatus> => {
      const res = await whatsappApiFetch("/backfill/status");
      if (!res.ok) throw new Error("Failed to load backfill status");
      return res.json();
    },
    refetchInterval: (query) => (query.state.data?.running ? 4000 : false),
    enabled,
  });
}

export function useTriggerBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (days: number) => {
      const res = await whatsappApiFetch("/backfill", {
        method: "POST",
        body: JSON.stringify({ days }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to start backfill");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-backfill-status"] });
    },
  });
}

export interface AskDocument {
  id: string;
  filename: string;
  mimetype: string | null;
  chatName: string | null;
  from: string | null;
  timestamp: number;
  kind: string;
}

export interface AskMessage {
  role: "user" | "assistant";
  content: string;
  documents?: AskDocument[];
  error?: boolean;
}

export function useAskWhatsApp() {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [isPending, setIsPending] = useState(false);

  const ask = async (question: string) => {
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setIsPending(true);
    try {
      const history = messages.map(({ role, content }) => ({ role, content }));
      const res = await whatsappApiFetch("/ask", {
        method: "POST",
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.error || "Something went wrong.", error: true }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data.answer, documents: data.documents }]);
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: "Something went wrong.", error: true }]);
    } finally {
      setIsPending(false);
    }
  };

  return { messages, ask, isPending };
}

export function whatsappDocumentDownloadUrl(id: string) {
  return `${WHATSAPP_API_BASE}/documents/${encodeURIComponent(id)}/download`;
}

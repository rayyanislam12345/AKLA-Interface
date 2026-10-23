import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, PanelRight, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CLAUDE_NEW_CHAT, openInClaude } from "@/lib/openInClaude";

// The address claude.ai is given for the firm's connector
// (chat-service/connector/, docs/claude-ai-connector.md).
const CONNECTOR_URL = "https://aklachat.duckdns.org/mcp";

// Set once the companion's Chrome Web Store listing is live
// (docs/companion-web-store.md); until then an administrator installs it.
const COMPANION_STORE_URL = "";

const EXAMPLES = [
  "List my projects in the AKLA Hub.",
  "Find the firm's precedents on liquidated damages for delay.",
  "What does section 199 of the Companies Act, 2017 say? Quote the section.",
  "In the AKLA Hub, summarise the latest version of each document in the project I name next.",
];

interface Connection {
  connected_at: string | null;
  last_used_at: string | null;
  can_save: boolean | null;
}

// Null when not connected; undefined while loading or when the database
// does not have the check yet (then the page says nothing about it).
function useMyClaudeConnection() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["my-claude-connection", user?.id],
    enabled: !!user,
    retry: false,
    queryFn: async (): Promise<Connection | null> => {
      const { data, error } = await supabase.rpc("my_claude_connection" as never);
      if (error) throw error;
      const rows = (data ?? []) as Connection[];
      return rows[0] ?? null;
    },
  });
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;

function ConnectionStatus() {
  const { data, isError, isLoading } = useMyClaudeConnection();
  if (isLoading || isError || data === undefined) return null;
  if (!data) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        Your Claude is not connected to the Hub yet. Follow the steps below; it takes about two minutes.
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p>
          Your Claude is connected to the Hub{data.connected_at ? ` (since ${when(data.connected_at)})` : ""}
          {data.last_used_at ? `, last used ${when(data.last_used_at)}` : ""}.
        </p>
        {data.can_save === false && (
          <p className="mt-1">
            This connection can read but not save. To let Claude file drafts into projects, remove AKLA Hub in
            Claude's connector settings and add it again (steps 1–3).
          </p>
        )}
      </div>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 text-sm">{value}</code>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast({ title: "Copied" });
          } catch {
            toast({ title: "Couldn't copy", description: "Select the text and copy it yourself." });
          }
        }}
      >
        <Copy className="mr-1 h-3.5 w-3.5" />
        Copy
      </Button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">{title}</p>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

export default function ClaudePage() {
  const { toast } = useToast();
  const [tried, setTried] = useState<string | null>(null);

  const tryExample = async (prompt: string) => {
    setTried(prompt);
    const copied = await openInClaude(prompt);
    toast({
      title: "Opened in Claude",
      description: copied
        ? "The request is in Claude's message box. If the box is empty, paste it (Ctrl+V or ⌘V)."
        : "The request is in Claude's message box. Press Enter to send it.",
    });
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Sparkles className="h-6 w-6 text-accent" />
          Use with Claude
        </h1>
        <p className="text-muted-foreground">
          Ask, draft and review in Claude, with the firm's projects, documents, precedents and laws at hand. Drafts
          Claude makes are filed in the project here, and it asks you before each one.
        </p>
      </div>

      <ConnectionStatus />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect Claude to the Hub (once)</CardTitle>
          <CardDescription>On claude.ai or in the Claude desktop app, signed in with your own Claude account.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-5">
            <Step n={1} title="Open Claude's connector settings">
              <p>
                In Claude, open <strong>Customize → Connectors</strong> (in some versions <strong>Settings →
                Connectors</strong>) and choose <strong>Add custom connector</strong>.
                If your firm's Claude already lists <strong>AKLA Hub</strong> there, skip to step 3.
              </p>
            </Step>
            <Step n={2} title="Add the AKLA Hub">
              <p>
                Name it <strong>AKLA Hub</strong> and paste this address, then press <strong>Add</strong>:
              </p>
              <CopyField value={CONNECTOR_URL} />
            </Step>
            <Step n={3} title="Sign in with your Hub login">
              <p>
                Press <strong>Connect</strong>. A Hub page opens: enter the email and password you use here (and your
                six-digit code if you use two-step sign-in), then <strong>Sign in and connect</strong>.
              </p>
            </Step>
            <Step n={4} title="Turn it on in a chat">
              <p>
                In a new chat, open the tools button under the message box and make sure <strong>AKLA Hub</strong> is
                on. Claude asks before it saves anything; choose <strong>Allow</strong> when you want the draft filed.
              </p>
            </Step>
          </ol>
          <p className="mt-5 text-xs text-muted-foreground">
            The connection lasts thirty days of use; after that Claude asks you to sign in again. For a firm Claude
            (Team or Enterprise), an owner can add AKLA Hub once for everyone under the organisation's connector
            settings, and then each person only does step 3.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Try it</CardTitle>
          <CardDescription>Each opens a new Claude chat with the request typed in. Press Enter to send.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {EXAMPLES.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => tryExample(prompt)}
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted ${
                tried === prompt ? "border-accent" : ""
              }`}
            >
              <span>{prompt}</span>
              <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            Every project and document page here also has an <strong>Open in Claude</strong> button that names it for
            you.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PanelRight className="h-4 w-4" />
            See the document beside the chat (optional)
          </CardTitle>
          <CardDescription>
            In the Claude desktop app, a Hub link Claude gives you opens beside the chat by itself. In Chrome, the AKLA
            Hub companion does the same.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {COMPANION_STORE_URL ? (
            <Button asChild>
              <a href={COMPANION_STORE_URL} target="_blank" rel="noreferrer">
                Add the companion to Chrome
              </a>
            </Button>
          ) : (
            <p>Ask an administrator to install the companion in your Chrome; a one-click install is on its way.</p>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        The Hub's own assistant is being retired in favour of Claude. Until it is switched off you can still{" "}
        <Link to="/assistant" className="underline underline-offset-2">
          open the Hub's assistant
        </Link>
        . <a href={CLAUDE_NEW_CHAT} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open Claude</a>
      </p>
    </div>
  );
}

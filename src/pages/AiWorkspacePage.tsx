import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { MessageSquare, ScanSearch, Sparkles } from "lucide-react";
import { useMatter } from "@/hooks/useMatters";
import AskPanel from "@/components/ai/AskPanel";
import DraftPanel from "@/components/ai/DraftPanel";
import VerifyPanel from "@/components/ai/VerifyPanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MODES = ["ask", "draft", "verify"] as const;
type Mode = (typeof MODES)[number];

function isMode(value: string | null): value is Mode {
  return MODES.includes(value as Mode);
}

// One matter-scoped page for all three AI features, switched by the tabs at
// the top. The mode (and, for Verify, the document) lives in the URL so the
// matter page's buttons can deep-link straight to a tab and a document.
export default function AiWorkspacePage() {
  const { matterId } = useParams<{ matterId: string }>();
  if (!matterId) return null;
  // Keyed on the matter so navigating between matters resets every panel —
  // React Router reuses this element across param changes otherwise.
  return <AiWorkspace key={matterId} matterId={matterId} />;
}

function AiWorkspace({ matterId }: { matterId: string }) {
  const { data: matter } = useMatter(matterId);
  const [searchParams, setSearchParams] = useSearchParams();

  const rawMode = searchParams.get("mode");
  const mode: Mode = isMode(rawMode) ? rawMode : "ask";
  const verifyDocumentId = searchParams.get("doc") ?? undefined;

  // Panels are mounted on first visit and then kept mounted (just hidden), so
  // an interview mid-way, a generated draft, or a running review survives a
  // quick hop to Ask and back. Radix TabsContent would unmount the inactive
  // ones, so the tabs here are only the header — the panels are plain divs.
  const [visited, setVisited] = useState<Set<Mode>>(() => new Set([mode]));
  useEffect(() => {
    setVisited((prev) => (prev.has(mode) ? prev : new Set(prev).add(mode)));
  }, [mode]);

  const setMode = (next: Mode) => {
    const params = new URLSearchParams(searchParams);
    params.set("mode", next);
    setSearchParams(params, { replace: true });
  };

  const setVerifyDocument = (matterDocumentId: string | undefined) => {
    const params = new URLSearchParams(searchParams);
    params.set("mode", "verify");
    if (matterDocumentId) params.set("doc", matterDocumentId);
    else params.delete("doc");
    setSearchParams(params);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">AI Workspace</h1>
        <p className="text-muted-foreground">{matter?.name}</p>
      </div>

      <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
        <TabsList>
          <TabsTrigger value="ask">
            <MessageSquare className="h-4 w-4 mr-2" />
            Ask
          </TabsTrigger>
          <TabsTrigger value="draft">
            <Sparkles className="h-4 w-4 mr-2" />
            Draft
          </TabsTrigger>
          <TabsTrigger value="verify">
            <ScanSearch className="h-4 w-4 mr-2" />
            Verify
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Bare divs on purpose: Tailwind preflight's [hidden] rule loses to any
          display utility (flex/grid/block) on the same element. */}
      {visited.has("ask") && (
        <div hidden={mode !== "ask"}>
          <AskPanel matterId={matterId} active={mode === "ask"} />
        </div>
      )}
      {visited.has("draft") && (
        <div hidden={mode !== "draft"}>
          <DraftPanel matterId={matterId} matterName={matter?.name} />
        </div>
      )}
      {visited.has("verify") && (
        <div hidden={mode !== "verify"}>
          <VerifyPanel matterId={matterId} matterDocumentId={verifyDocumentId} onSelectDocument={setVerifyDocument} />
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Wand2 } from "lucide-react";
import { useMatterContext, useUpsertMatterContext } from "@/hooks/useMatterContext";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// The project's instructions for the AI: the facts, decisions and
// preferences carried into every chat about it (the site calls this
// Project Context; it is the same row, matter_context). "Summarise" drafts
// a first version from the project's documents and past chats.
export default function ProjectInstructions({ matterId }: { matterId: string }) {
  const { toast } = useToast();
  const { data: matterContext, isLoading } = useMatterContext(matterId);
  const upsert = useUpsertMatterContext();
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  useEffect(() => {
    if (loaded || matterContext === undefined) return;
    setDraft(matterContext?.content ?? "");
    setLoaded(true);
  }, [matterContext, loaded]);

  const saved = matterContext?.content ?? "";
  const dirty = loaded && draft !== saved;

  const save = () =>
    upsert.mutate(
      { matterId, content: draft },
      {
        onSuccess: () => toast({ title: "Instructions saved" }),
        onError: (err) => toast({ title: "Couldn't save", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
      },
    );

  const summarise = async () => {
    setSummarizing(true);
    try {
      const { data, error } = await supabase.functions.invoke("summarize-matter-context", { body: { matterId } });
      if (error) throw error;
      if (!data?.summary) {
        toast({ title: "Nothing to summarise yet", description: "This project has no documents or past chats to draw on." });
        return;
      }
      setDraft((prev) => (prev.trim() ? `${prev.trim()}\n\n${data.summary}` : data.summary));
      toast({
        title: "Summary added. Read it before saving",
        description: `Drawn from ${data.documentCount} document${data.documentCount === 1 ? "" : "s"} and ${data.messageCount} past AI message${data.messageCount === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      toast({ title: "Couldn't summarise", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSummarizing(false);
    }
  };

  const updatedBy = (matterContext as { updated_by?: { full_name?: string | null } | null } | null | undefined)?.updated_by?.full_name;

  return (
    <section className="rounded-2xl border bg-card px-4 py-3" data-testid="project-instructions">
      <h2 className="text-sm font-medium">Instructions</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">What every chat about this project should know: the deal, the parties, decisions already taken, how you like things done.</p>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={isLoading ? "Loading…" : "Key facts, decisions and preferences for this project…"}
        disabled={isLoading}
        className="mt-2 min-h-[7rem] text-sm"
        aria-label="Project instructions"
      />
      {updatedBy && matterContext?.updated_at && (
        <p className="mt-1 text-[11px] text-muted-foreground">Last saved by {updatedBy} · {new Date(matterContext.updated_at).toLocaleDateString()}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" className="h-8" onClick={save} disabled={!dirty || upsert.isPending}>
          {upsert.isPending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={summarise} disabled={summarizing || isLoading}>
          <Wand2 className="mr-1.5 h-3.5 w-3.5" />
          {summarizing ? "Summarising…" : "Summarise from the files"}
        </Button>
      </div>
    </section>
  );
}

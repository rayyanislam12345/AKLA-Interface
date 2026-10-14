import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ProjectSearchPage from "@/pages/ProjectSearchPage";
import PrecedentSearchTab from "@/components/precedents/PrecedentSearchTab";

// The assistant's search: the two places a lawyer used to look separately —
// project documents, notes and tasks (plain word search) and clauses in the
// firm's precedents (search by meaning) — side by side under one door. The
// tab is in the URL so links from a project page land on the right one.
export default function AssistantSearchPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "clauses" ? "clauses" : "projects";
  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Search className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">Find a document or clause</h1>
          <p className="text-muted-foreground">Search the firm's projects by word, or its precedents by meaning.</p>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="projects">Project documents, notes & tasks</TabsTrigger>
          <TabsTrigger value="clauses">Clauses in firm precedents</TabsTrigger>
        </TabsList>
        <TabsContent value="projects" className="pt-4">
          <ProjectSearchPage embedded />
        </TabsContent>
        <TabsContent value="clauses" className="pt-4">
          <PrecedentSearchTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

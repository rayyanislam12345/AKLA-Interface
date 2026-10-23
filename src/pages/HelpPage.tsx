import { friendlyError } from "@/lib/friendlyError";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useProfiles";
import { useToast } from "@/hooks/use-toast";
import { NAV_ITEMS } from "@/components/AppSidebar";
import {
  Search,
  BookOpen,
  FolderKanban,
  FileText,
  Sparkles,
  ScanSearch,
  MessageCircle,
  BookMarked,
  Users,
  HelpCircle,
  Lightbulb,
  Clock,
  Mic,
  Settings,
  Inbox,
  Loader2,
} from "lucide-react";

interface HelpItem {
  question: string;
  answer: string;
  bullets?: string[];
}

interface HelpSection {
  id: string;
  title: string;
  icon: typeof BookOpen;
  description: string;
  content: HelpItem[];
  faqs: HelpItem[];
}

// One line per sidebar item, keyed by its address. The list itself comes
// from the sidebar (NAV_ITEMS), so a new or renamed item shows up here
// without anyone retyping it; an item with no line here is still listed.
const NAV_DESCRIPTIONS: Record<string, string> = {
  "/assistant":
    "the AI. Ask a question, drop in a document, or type / to draft, review or summarise. Works with or without a project.",
  "/dashboard": "a firm-wide view: project counts, today's legal updates and the project list.",
  "/matters": "every project. Open one for its documents, tasks and time.",
  "/claude": "how to connect your own Claude to the Hub, so you can ask, draft and review there with the firm's projects, precedents and laws.",
  "/clients": "the clients that projects are attached to.",
  "/team": "everyone at the firm and their role. Admins approve new accounts here.",
  "/timesheet": "your own time for any day. Add, edit or delete entries and download the firm's timesheet file.",
  "/record-meeting": "live transcription of a meeting, then proposal letters, minutes or a concept note from it.",
  "/precedent-library": "the firm's own agreements and the laws the AI draws on, with clause search and firm standards.",
  "/caselaw-research": "ask a question of Pakistani case law and get judgments with links.",
  "/mandate-opportunities": "new tenders and PPP opportunities found on public procurement sites.",
  "/whatsapp-activity": "client matters and documents picked up from a linked WhatsApp account.",
  "/document-types": "the firm's list of document types (Concession Agreement, EPC Contract and so on).",
  "/help": "this page.",
};

const navigationBullets = [
  ...NAV_ITEMS.map((item) =>
    NAV_DESCRIPTIONS[item.url] ? `${item.title}: ${NAV_DESCRIPTIONS[item.url]}` : item.title
  ),
  "Settings (at the bottom, under your email): your name, password, two-step sign-in, signing out of all devices, and links to the less-used pages (Clients, the firm overview, WhatsApp Activity).",
];

interface SupportRequestRow {
  id: string;
  user_id: string | null;
  subject: string;
  message: string;
  status: string;
  created_at: string;
  sender: string;
}

// Admins only (RLS "Users can view their own support requests" lets admins
// read every row): the questions people send from the form below, newest
// first, with a way to mark each one dealt with.
function SupportRequestsForAdmins() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["support-requests"],
    queryFn: async (): Promise<SupportRequestRow[]> => {
      const { data: rows, error } = await supabase
        .from("support_requests")
        .select("id, user_id, subject, message, status, created_at")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      const ids = [...new Set((rows ?? []).map((r) => r.user_id).filter((id): id is string => !!id))];
      const { data: people } = ids.length
        ? await supabase.from("profiles").select("id, full_name, email").in("id", ids)
        : { data: [] as { id: string; full_name: string | null; email: string }[] };
      const nameOf = new Map((people ?? []).map((p) => [p.id, p.full_name || p.email]));
      return (rows ?? []).map((r) => ({ ...r, sender: (r.user_id && nameOf.get(r.user_id)) || "Unknown" }));
    },
  });

  const setStatus = async (id: string, status: "open" | "answered") => {
    const { error } = await supabase.from("support_requests").update({ status }).eq("id", id);
    if (error) {
      toast({ title: "Could not update the request", description: friendlyError(error), variant: "destructive" });
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["support-requests"] });
  };

  const openCount = (data ?? []).filter((r) => r.status === "open").length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <Inbox className="h-6 w-6 text-primary" />
          <div>
            <CardTitle className="flex items-center gap-2">
              Questions from the team
              {openCount > 0 && <Badge>{openCount} open</Badge>}
            </CardTitle>
            <CardDescription>
              Sent with the form at the bottom of this page. Only admins see this list. Reply to the person directly,
              then mark the question answered.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Could not load questions: {(error as Error).message}</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">No questions yet.</p>
        ) : (
          <ul className="divide-y">
            {data.map((r) => (
              <li key={r.id} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium break-words">{r.subject}</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{r.message}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {r.sender} ·{" "}
                    {new Date(r.created_at).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                {r.status === "open" ? (
                  <Button size="sm" variant="outline" onClick={() => setStatus(r.id, "answered")}>
                    Mark answered
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Answered</Badge>
                    <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, "open")}>
                      Reopen
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const HelpPage = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("getting-started");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const { user } = useAuth();
  const { data: myProfile } = useMyProfile();
  const { toast } = useToast();
  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "founder";

  const helpSections: HelpSection[] = [
    {
      id: "getting-started",
      title: "Getting Started",
      icon: BookOpen,
      description: "What AKLA Project Hub is and how it's organized",
      content: [
        {
          question: "What is AKLA Project Hub?",
          answer:
            "The firm's own workspace: every PPP transaction and due-diligence engagement with its documents, an AI assistant that works from the firm's agreements and the law, your daily timesheet, meeting transcription, and the firm's library of past agreements and laws.",
        },
        {
          question: "How do I navigate the platform?",
          answer: "Everything is in the sidebar on the left, top to bottom:",
          bullets: navigationBullets,
        },
        {
          question: "How is data organized?",
          answer:
            "Client → Project → Documents, Stages, Parties, Tasks, Notes and Time. Access is firm-wide by design: every lawyer can see and work on every project.",
        },
        {
          question: "How do the AI features work?",
          answer:
            "Open AI Assistant (first item in the sidebar). You can use it without choosing a project: ask a question, drop in a document, or type / to pick Draft, Review, Summarise or one of the firm's own skills. To work on a particular transaction, open the project and press Ask AI (or Draft with AI on its Documents card); the assistant then also reads that project's documents. Answers come from the firm's agreements, the law library and, inside a project, its documents, with the sources listed under each reply. Drafts leave unknown commercial terms as marked placeholders such as [CONCESSION PERIOD — TO BE CONFIRMED] instead of inventing figures.",
        },
      ],
      faqs: [
        {
          question: "Do I need to set anything up before using AI features?",
          answer:
            "No. If an AI feature says it isn't available, tell an administrator — it is a server setting, not something you configure. Project tracking, document upload and everything else work regardless.",
        },
        {
          question: "Can multiple lawyers work on the same project?",
          answer:
            "Yes. Firm-wide access means every lawyer can view and edit every project — there's no per-matter permission to configure.",
        },
      ],
    },
    {
      id: "matters",
      title: "Projects",
      icon: FolderKanban,
      description: "Track a transaction from origination through closing",
      content: [
        {
          question: "How do I create a project?",
          answer:
            "Go to Projects and click New Project. Give it a name, and optionally a client, sector, and project lead. A default stage checklist is seeded automatically for you.",
        },
        {
          question: "What are the default stages?",
          answer:
            "A standard PPP transaction pipeline: Origination, Due Diligence, Drafting, Negotiation, Financial Close, and Post-Closing. Click a stage in the project workspace to cycle it through not started → in progress → complete.",
        },
        {
          question: "What's in a project workspace?",
          answer:
            "Stages (the checklist), Documents (every document on the project with its status), Parties (counterparties like the Grantor, Concessionaire, or EPC Contractor), Tasks (simple to-dos with a checkbox), and Notes (a running activity log).",
          bullets: [
            "Stages — click to advance not started → in progress → complete.",
            "Documents — create a document, upload versions, change status, or open it in the AI Assistant to draft or review it.",
            "Parties — add a name and role for each counterparty on the deal.",
            "Tasks — add a task; check it off when done.",
            "Notes — free-text notes, newest first.",
          ],
        },
        {
          question: "What do document statuses mean?",
          answer:
            "Not started → Drafting → Internal Review → With Counterparty → Negotiation → Finalized → Executed. Change a document's status from the dropdown next to it in the Documents card — nothing advances automatically.",
        },
        {
          question: "What are Clients?",
          answer:
            "Client entities that projects are attached to, managed from the Clients page. A project doesn't require a client, but linking one lets you filter and gives AI drafting more context.",
        },
      ],
      faqs: [
        {
          question: "Can I restrict a project to specific lawyers?",
          answer:
            "Not currently — the firm uses firm-wide visibility by design, so there's no per-matter access control to set.",
        },
        {
          question: "Can I edit the stage checklist after a project is created?",
          answer:
            "Stages seed automatically on creation; there's no UI yet to add or remove stages after the fact.",
        },
      ],
    },
    {
      id: "documents",
      title: "Documents",
      icon: FileText,
      description: "Upload, version, and track documents on a project",
      content: [
        {
          question: "How do I upload a document?",
          answer:
            "Open the project and go to its Documents card. Type the document's title, pick its type and press +. The document appears in the list; press the upload icon on its row and choose the file. Uploading again to the same document adds a new version; nothing is overwritten. Files you drop into an AI Assistant chat are read by the assistant for that conversation but are not saved to the project. To keep something the assistant produced, press \"Save to project\" under it.",
        },
        {
          question: "What happens to a file after I upload it?",
          answer:
            "Its text is extracted (PDF, Word, Excel, or PowerPoint) and embedded into the document knowledge base, so it becomes searchable and usable by Ask, Draft, and Review on that project.",
        },
        {
          question: "What document types are available?",
          answer:
            "The firm's contract taxonomy — Concession Agreement, EPC Contract, financing agreements, and more. See Document Types for the full list, or to add a new one.",
        },
      ],
      faqs: [
        {
          question: "What file formats are supported?",
          answer: "PDF, DOCX, XLSX/XLS, and PPTX.",
        },
        {
          question: "Why didn't my document show up in AI answers?",
          answer:
            "Extraction can fail on scanned or image-only PDFs with no real text layer underneath. The upload itself still succeeds, but there's nothing for AI features to read.",
        },
      ],
    },
    {
      id: "draft-with-ai",
      title: "Draft with AI",
      icon: Sparkles,
      description: "Generate a first draft from precedent or a guided interview",
      content: [
        {
          question: "How do I generate a draft?",
          answer:
            "Two ways. Without a project: open AI Assistant, type / and choose Draft, then say what you need. For a project: open it and press Draft with AI on its Documents card. Either way the assistant asks a few short questions (say \"just draft it\" to skip them) and the draft opens in the panel on the right, where you can edit it, download it as a Word file, or save it to a project as a new version.",
        },
        {
          question: "What does the assistant ask before drafting?",
          answer:
            "One short question at a time about the key commercial terms: parties, term, payment, security, governing law and so on. Say \"just draft it\" at any point and it drafts from what it has, using the firm's standard and past agreements for that document type.",
        },
        {
          question: "What happens to the draft once it's generated?",
          answer:
            "It opens in the panel on the right of the chat, where you can edit it and see it as the firm-formatted Word file. Read and edit it before sending it anywhere.",
        },
        {
          question: "How do I save a draft?",
          answer:
            "Press \"Save new version\" in the draft panel and choose the project (if the chat isn't already in one). It is saved as a new Word version of that project's document. \"Download .docx\" gives you the file without saving it to a project.",
        },
        {
          question: "Will the AI invent commercial terms I never gave it?",
          answer:
            "No. Where a specific term wasn't provided, the draft inserts a clearly marked placeholder like [CONCESSION PERIOD — TO BE CONFIRMED] instead of guessing a figure.",
        },
      ],
      faqs: [
        {
          question: "What if there's no precedent or standard template for a document type yet?",
          answer:
            "It drafts from standard market practice instead, and the note above the draft will say so.",
        },
        {
          question: "Will I lose the conversation if I leave the page?",
          answer:
            "No. Every chat is kept in the list on the left of the AI Assistant, where you can pick it up again, pin it, rename it or archive it.",
        },
      ],
    },
    {
      id: "review-with-ai",
      title: "Review with AI",
      icon: ScanSearch,
      description: "Get clause-level redline suggestions against precedent",
      content: [
        {
          question: "How do I get redline suggestions on a draft?",
          answer:
            "Click the review icon next to a document in the project's Documents card (it needs at least one uploaded version) — that opens the AI Assistant with Review in force and the document attached; press send. Or in any chat, type / and choose Review, then use the + menu → Add from project to attach the document. A review first looks up the law that may apply on official sources, then runs its three passes. Follow-up messages in the same chat are checked against that review rather than starting a new one; attach a different document or say “re-run the review” for a fresh one. The review opens in the panel on the right with the suggestions, tracked-changes preview, download and save-as-version.",
        },
        {
          question: "What does the review actually check?",
          answer:
            "Three separate passes: Legal Clauses & Citations (clause correctness against statute and precedent, and assertions made without citation), Formatting (structure against the firm's template and precedent), and Content & Conflicts (content against precedent, and against this project's other documents). Suggestions are grouped by pass.",
        },
        {
          question: "How do I act on a suggestion?",
          answer:
            "Accept or Reject each one individually. Nothing is applied to the document automatically — every change is a deliberate choice.",
        },
        {
          question: "Where do I see the changes?",
          answer:
            "For a Word document, the real uploaded file is shown alongside the list with every accepted or pending suggestion applied as genuine tracked changes (insertions underlined, deletions struck through). Download .docx gives you that file to open in Word; Save as Document Version keeps it on the project as a new version.",
        },
        {
          question: "Can I review a PDF, Excel file, or PowerPoint?",
          answer:
            "Yes — the review runs the same way, and each suggestion shows its original and proposed text in the list. Only the tracked-changes preview, download and save-as-version are Word-only, because they patch the actual .docx.",
        },
      ],
      faqs: [
        {
          question: "Can I re-run the review on the same document?",
          answer:
            "Yes. Re-running clears out the old pending suggestions before generating fresh ones, but any suggestions you already accepted or rejected are left alone.",
        },
        {
          question: "Some suggestions say they couldn't be located in the file — why?",
          answer:
            "A suggestion is applied as a tracked change only where its original wording can be matched exactly in the document. If the AI paraphrased or the passage spans odd formatting, it's still listed for you to act on by hand — it just isn't drawn into the preview.",
        },
      ],
    },
    {
      id: "ai-assistant",
      title: "AI Assistant",
      icon: MessageCircle,
      description: "Ask, draft, review and summarise, with or without a project",
      content: [
        {
          question: "Where is it?",
          answer:
            "AI Assistant is the first item in the sidebar. It works like claude.ai: your conversations are listed on the left (pin, rename, archive), you type at the bottom, and drafts and reviews open in a panel on the right.",
        },
        {
          question: "Do I have to choose a project first?",
          answer:
            "No. Without a project the assistant answers from the firm's agreements and the law library, and from any file you drop into the chat. Open a project and press Ask AI when you want it to read that project's documents too; those chats are listed under the project.",
        },
        {
          question: "How do I give it a document?",
          answer:
            "Drop the file into the chat, or press + and choose Add from project (or Add from a project) to attach one of a project's documents. A dropped file is read for that conversation only; to keep it on a project, upload it on the project's Documents card.",
        },
        {
          question: "What are skills?",
          answer:
            "Type / in the message box to pick one: Draft, Review, Summarise, or one of the firm's own (for example the daily agenda or a concession agreement in the firm's format). The skill stays in force for the conversation.",
        },
        {
          question: "Does it remember earlier questions in the same conversation?",
          answer:
            "Yes. Follow-up questions like \"what about the dispute resolution clause\" carry the context of what was already discussed, and the sources it found stay available for the whole chat.",
        },
        {
          question: "What happens if it doesn't know the answer?",
          answer:
            "It says so rather than guessing, and lists the sources it did use under the reply so you can check them.",
        },
      ],
      faqs: [],
    },
    {
      id: "firm-library",
      title: "Firm Library",
      icon: BookMarked,
      description: "The firm's own agreements and the laws the AI draws on",
      content: [
        {
          question: "What is the Firm Library?",
          answer:
            "The firm's past agreements and the laws they rely on, independent of any single project. The AI Assistant draws on it when it drafts, reviews and answers. It has four tabs: Agreements, Find a clause, Laws and Standards.",
        },
        {
          question: "How do I add agreements to it?",
          answer:
            "Open Firm Library, stay on the Agreements tab, and in Bulk Upload pick a document type, add one or more files, then upload. Every file in a batch is tagged with the same type; upload again for a different type.",
        },
        {
          question: "How do I find a clause?",
          answer:
            "Use the Find a clause tab: type what you're looking for (for example liquidated damages, step-in rights or change in law) and, if you like, limit it to one document type. It searches every agreement in the library.",
        },
        {
          question: "What are Laws and Standards?",
          answer:
            "Laws lists the Acts and rules the AI can quote, with a link to each source. Standards holds the firm's standard form for a document type, which the AI can build from the firm's agreements and the relevant law.",
        },
        {
          question: "Can I remove something from the library?",
          answer:
            "Yes — deleting a source removes both the underlying file and everything indexed from it.",
        },
      ],
      faqs: [
        {
          question: "Is the library tied to a specific project?",
          answer: "No. It's firm-wide and every project and conversation can use it.",
        },
      ],
    },
    {
      id: "timesheet",
      title: "Today's Timesheet",
      icon: Clock,
      description: "Record your time and download the daily timesheet",
      content: [
        {
          question: "How do I record time?",
          answer:
            "Open Today's Timesheet in the sidebar and press Add entry. Choose the project, describe the work, and enter the hours. Billable hours and AK billable hours are optional and can't be more than the hours worked. It works the same on a phone.",
        },
        {
          question: "Can I fill in or fix another day?",
          answer:
            "Yes. Use Previous day and Next day, or pick a date in the date box. Dates follow your own clock, so work done after midnight counts for the new day.",
        },
        {
          question: "How do I change or remove an entry?",
          answer:
            "Click into any box on a row and type; it saves when you click away. The bin icon at the end of a row deletes that entry after you confirm. Drag a row by its grip handle to change the order.",
        },
        {
          question: "How do I get the timesheet file?",
          answer:
            "Press Download Timesheet (.docx). It builds the firm's daily timesheet for the day shown, with your name and role.",
        },
        {
          question: "What is Timekeeper?",
          answer:
            "An optional Windows app some of the firm uses to track time in the background. Entries it uploads appear on this page like any other. You do not need it: everything can be entered here.",
        },
      ],
      faqs: [],
    },
    {
      id: "record-meeting",
      title: "Record Meeting",
      icon: Mic,
      description: "Transcribe a meeting and turn it into a letter, minutes or a concept note",
      content: [
        {
          question: "How do I record a meeting?",
          answer:
            "Open Record Meeting, choose the language (English, or Urdu which is translated when you generate a document) and the audio source (your microphone, or microphone plus the meeting's audio for an online call), then press Start Meeting. The transcript appears as people speak. Press Stop Meeting when you're done.",
        },
        {
          question: "I already have a recording or transcript.",
          answer: "Use Upload Recording… or Upload Transcript… instead of starting a live meeting.",
        },
        {
          question: "What can it produce?",
          answer:
            "Generate Proposal (AKLA Format), Generate Minutes (AKLA Format) or Generate Concept Note. Each draft can be saved as a Word file, uploaded to a project, or opened in the AI Assistant to refine.",
        },
      ],
      faqs: [],
    },
    {
      id: "settings",
      title: "Settings",
      icon: Settings,
      description: "Your name, password and sign-in security",
      content: [
        {
          question: "Where are my settings?",
          answer:
            "Press Settings at the bottom of the sidebar, under your email. There you can correct your name, change your password, turn two-step sign-in on or off, and sign out of every device.",
        },
        {
          question: "What is two-step sign-in?",
          answer:
            "Also called two-factor authentication. Once it's on, signing in needs your password and a 6-digit code from an authenticator app on your phone, so someone who learns your password still can't get in.",
        },
        {
          question: "I forgot my password.",
          answer:
            "On the sign-in page press Forgot your password?, enter your email and use the link in the email you receive. Links expire; if one has, the page offers to send a new one.",
        },
      ],
      faqs: [],
    },
    {
      id: "team-and-types",
      title: "Team & Document Types",
      icon: Users,
      description: "Roles, permissions, and the firm's contract taxonomy",
      content: [
        {
          question: "What roles exist?",
          answer: "Founder, Admin, Partner, Senior Counsel, Associate, and Paralegal. Founders have the same permissions as admins.",
        },
        {
          question: "How do I change someone's role?",
          answer:
            "On the Team page, admins can pick a new role from the dropdown next to a lawyer's name. Everyone can view the Team page; only admins can change roles.",
        },
        {
          question: "How do I manage the document taxonomy?",
          answer:
            "On the Document Types page, admins can add, rename, or delete contract types, grouped by category. Everyone can view the list — it drives the type picker for drafting, the Firm Library and document uploads.",
        },
        {
          question: "Can I delete a document type that's in use?",
          answer:
            "No — the firm's own records (documents already tagged with that type) block the deletion, and you'll see a message explaining why rather than a silent failure.",
        },
      ],
      faqs: [],
    },
  ];

  const filteredSections = helpSections.filter((section) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      section.title.toLowerCase().includes(query) ||
      section.description.toLowerCase().includes(query) ||
      section.content.some(
        (item) => item.question.toLowerCase().includes(query) || item.answer.toLowerCase().includes(query)
      ) ||
      section.faqs.some(
        (faq) => faq.question.toLowerCase().includes(query) || faq.answer.toLowerCase().includes(query)
      )
    );
  });

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <HelpCircle className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">Help Center</h1>
            <p className="text-muted-foreground">Learn how to use AKLA Project Hub</p>
          </div>
        </div>
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search help topics..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex flex-wrap items-center justify-center h-auto gap-1 bg-primary/10 p-1">
          {filteredSections.map((section) => (
            <TabsTrigger key={section.id} value={section.id} className="flex items-center gap-1.5 text-xs">
              <section.icon className="h-3.5 w-3.5" />
              {section.title}
            </TabsTrigger>
          ))}
          <TabsTrigger value="faqs" className="flex items-center gap-1.5 text-xs">
            <MessageCircle className="h-3.5 w-3.5" />
            FAQs
          </TabsTrigger>
        </TabsList>

        {filteredSections.map((section) => (
          <TabsContent key={section.id} value={section.id}>
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <section.icon className="h-6 w-6 text-primary" />
                  <div>
                    <CardTitle>{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Accordion type="single" collapsible className="w-full">
                  {section.content.map((item, index) => (
                    <AccordionItem key={index} value={`${section.id}-${index}`}>
                      <AccordionTrigger className="text-left hover:no-underline">
                        <span className="flex items-center gap-2">
                          <Lightbulb className="h-4 w-4 text-accent flex-shrink-0" />
                          {item.question}
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="text-muted-foreground pl-6">
                        {item.answer}
                        {item.bullets && (
                          <ul className="list-disc pl-6 mt-2 space-y-1">
                            {item.bullets.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </CardContent>
            </Card>
          </TabsContent>
        ))}

        <TabsContent value="faqs">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <MessageCircle className="h-6 w-6 text-primary" />
                <div>
                  <CardTitle>Frequently Asked Questions</CardTitle>
                  <CardDescription>Common questions organized by topic</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {helpSections
                .filter((s) => s.faqs.length > 0)
                .map((section) => (
                  <div key={section.id}>
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                      <section.icon className="h-4 w-4" />
                      {section.title}
                    </h3>
                    <Accordion type="single" collapsible className="w-full">
                      {section.faqs.map((faq, index) => (
                        <AccordionItem key={index} value={`faq-${section.id}-${index}`}>
                          <AccordionTrigger className="text-left hover:no-underline">
                            {faq.question}
                          </AccordionTrigger>
                          <AccordionContent className="text-muted-foreground">{faq.answer}</AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>
                ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {isAdmin && <SupportRequestsForAdmins />}

      <Card>
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold mb-1">Need more help?</h3>
          <p className="text-muted-foreground mb-4">
            Send a question to the firm's admins. They see it on this page and will reply to you directly.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const subject = (form.elements.namedItem("subject") as HTMLInputElement).value.trim();
              const message = (form.elements.namedItem("message") as HTMLTextAreaElement).value.trim();
              if (!subject || !message) return;
              if (!user) {
                toast({ title: "Your question was not sent", description: "Sign in again and retry.", variant: "destructive" });
                return;
              }

              setSending(true);
              const { error } = await supabase.from("support_requests").insert({
                user_id: user.id,
                subject,
                message,
              });
              setSending(false);

              if (error) {
                toast({
                  title: "Your question was not sent",
                  description: `${error.message}. Please try again, or message an admin directly.`,
                  variant: "destructive",
                });
                return;
              }

              form.reset();
              setShowConfirmDialog(true);
            }}
            className="space-y-3"
          >
            <Input name="subject" placeholder="Subject" required maxLength={255} />
            <Textarea
              name="message"
              placeholder="Describe your question or issue..."
              required
              maxLength={2000}
              className="min-h-[100px]"
            />
            <Button type="submit" size="sm" disabled={sending}>
              {sending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit Question
            </Button>
          </form>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl">Question sent</AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              The firm's admins can see your question on the Help page and will reply to you directly.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setShowConfirmDialog(false)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default HelpPage;

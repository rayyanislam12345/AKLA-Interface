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
  "/legal-updates": "the morning briefing on new and amended laws, and what is awaiting its official text.",
  "/claude": "how to connect your own Claude to the Hub, so you can ask, draft and review there with the firm's projects, precedents and laws.",
  "/clients": "the clients that projects are attached to.",
  "/team": "everyone at the firm and their role. Admins approve new accounts here.",
  "/timesheet": "your own time for any day. Add, edit or delete entries and download the firm's timesheet file.",
  "/record-meeting": "record a meeting; its minutes, proposal or concept note are saved into the project.",
  "/precedent-library": "the firm's own agreements and the laws Claude draws on, with clause search and firm standards.",
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
      description: "What the Hub is and where things are",
      content: [
        {
          question: "What is AKLA Project Hub?",
          answer:
            "The firm's own workspace: every transaction with its documents, the firm's library of past agreements and laws, meeting recording, and your timesheet. You ask, draft and review in Claude, which reads and files into the Hub once it is connected (see Using Claude).",
        },
        {
          question: "How do I find my way around?",
          answer: "Everything is in the sidebar on the left, top to bottom:",
          bullets: navigationBullets,
        },
        {
          question: "How is the work organised?",
          answer:
            "Client → Project → Documents, each document with its versions. Every lawyer at the firm can see and work on every project.",
        },
        {
          question: "What should I do first?",
          answer:
            "Connect your Claude to the Hub once (Use with Claude in the sidebar; about two minutes). Then open Projects, open or create your project, and drop its files onto the Documents card.",
        },
      ],
      faqs: [
        {
          question: "Can several lawyers work on the same project?",
          answer: "Yes. There is no per-project permission to set: every lawyer can view and edit every project.",
        },
      ],
    },
    {
      id: "matters",
      title: "Projects",
      icon: FolderKanban,
      description: "A transaction and everything filed on it",
      content: [
        {
          question: "How do I create a project?",
          answer:
            "Open Projects and press New Project. Type its name and, if you like, its client: an existing client by name, or a new one, which is added for you. You are its lead unless you choose someone else under More details. The new project opens straight away.",
        },
        {
          question: "What is on a project's page?",
          answer:
            "Its documents first, then its tasks and time. Stages, parties, notes, project context, the laws it relies on and WhatsApp activity show once they hold something; Show empty sections at the bottom brings them all up.",
          bullets: [
            "Open in Claude starts a Claude chat about the project with its name already typed; add your question and press Enter.",
            "Record meeting opens Record Meeting with this project already chosen.",
            "Search project finds a phrase in every document on the project.",
          ],
        },
        {
          question: "What do the document statuses mean?",
          answer:
            "Not started → Drafting → Internal review → With counterparty → Negotiation → Finalized → Executed. The status is set from the file's name when you upload it (see Documents); change it from the drop-down on the document's row.",
        },
        {
          question: "Where are the legal updates?",
          answer:
            "On Legal Updates in the sidebar: the morning briefing on new and amended laws, what was found, and what is still awaiting its official text. The bell at the top right tells you when a law one of your projects relies on changes.",
        },
        {
          question: "Where are Clients?",
          answer: "Linked from the top of the Projects page, and from Settings › Other pages.",
        },
      ],
      faqs: [],
    },
    {
      id: "documents",
      title: "Documents",
      icon: FileText,
      description: "Upload, version, read and download a project's documents",
      content: [
        {
          question: "How do I upload documents?",
          answer:
            "Open the project and drag the files, a folder or a .zip onto the Documents card, or press Upload files. Each file becomes a document named from its file name; a file whose name matches a document already there is offered as its next version. Check the list and press Start. Don't leave the page until it finishes.",
        },
        {
          question: "Do I have to set each document's type and status?",
          answer:
            "No. The type comes from the file's name when it names one of the firm's types (\"Concession Agreement\", \"(CTA)\", \"SHA\"), and the status from a tag in square brackets: [Executed], [Circulated] or [Received], [For Partner Review], [Final]; a new file with no tag is Drafting. A few minutes after upload the Hub reads the file and, where it still has no type, offers \"Set type: …\" on the row, or \"Set all\" for several.",
        },
        {
          question: "How do I see what a document is about without opening it?",
          answer:
            "The line under its title is the Hub's summary of the latest version. Open it and choose the Summary tab for the parties, key dates and the laws it mentions. The summary is written from the text; check it against the document.",
        },
        {
          question: "How do I add a new version?",
          answer:
            "Drop the file on the Documents card (it is matched by name), or press the upload icon on the document's row to add it to that document. Nothing is ever overwritten; every version is kept.",
        },
        {
          question: "How do I download?",
          answer:
            "The download icon on a row gives the latest version. Tick several rows and press Download selected, or Download all, for one .zip. In a document's preview, Download offers a clean copy or one with tracked changes when it has them.",
        },
      ],
      faqs: [
        {
          question: "What file types can I upload?",
          answer: "Any. Word, PDF, Excel and PowerPoint files are read so Claude and search can use them; other files are kept and can be downloaded.",
        },
        {
          question: "Why doesn't Claude find something in my document?",
          answer:
            "A scanned PDF with no text in it can't be read; the row then says it couldn't be read. Upload a Word copy, or a PDF with selectable text.",
        },
      ],
    },
    {
      id: "claude",
      title: "Using Claude",
      icon: Sparkles,
      description: "Ask, draft and review in Claude with the firm's documents",
      content: [
        {
          question: "How do I connect Claude to the Hub?",
          answer:
            "Once, on Use with Claude in the sidebar: in Claude, add a custom connector called AKLA Hub with the address that page gives you, then press Connect and sign in with your Hub email and password. The page then shows that your Claude is connected.",
        },
        {
          question: "What can Claude do with the Hub?",
          answer:
            "Find and read any project's documents, the firm's precedents and the law library, and answer with sources you can open. It drafts in the firm's own format and files the draft in the project, marks up a document with tracked changes as its next version, and runs the Hub's review. It asks before it saves anything, and it never deletes.",
        },
        {
          question: "What is the quickest way to start?",
          answer:
            "Use the Open in Claude, Draft in Claude and Review in Claude buttons on a project and its documents: each opens a new Claude chat with the project and document already named. Add your request and press Enter. If the message box comes up empty, paste: the request is copied for you.",
        },
        {
          question: "How do I see the document beside the chat?",
          answer:
            "In the Claude desktop app, a Hub link Claude gives you opens beside the chat. In Chrome, the AKLA Hub companion does the same; ask an administrator to install it.",
        },
        {
          question: "Where do drafts and reviews end up?",
          answer:
            "In the project, as a new version of the document, so the whole team sees them. A review's suggestions are tracked changes in that version: open it and accept or reject each one in its Changes tab.",
        },
      ],
      faqs: [
        {
          question: "Claude says it can't find the Hub.",
          answer:
            "In the chat, open the tools button under the message box and turn AKLA Hub on. If Use with Claude says you are not connected, follow its steps again; a connection lasts thirty days of use.",
        },
        {
          question: "What about the Hub's own assistant?",
          answer:
            "It is being retired in favour of Claude. Until it is switched off it is still linked from Use with Claude and Settings › Other pages, and your earlier chats are there.",
        },
      ],
    },
    {
      id: "firm-library",
      title: "Firm Library",
      icon: BookMarked,
      description: "The firm's own agreements and the laws",
      content: [
        {
          question: "What is the Firm Library?",
          answer:
            "The firm's past agreements and the laws they rely on, independent of any project. Claude draws on it when it drafts, reviews and answers. Its tabs are Agreements, Find a clause, Laws and Standards.",
        },
        {
          question: "How do I add agreements?",
          answer:
            "On the Agreements tab, under Bulk Upload, pick the document type, add the files and press Upload. Every file in a batch gets the same type; upload again for another type.",
        },
        {
          question: "How do I find a clause?",
          answer:
            "On the Find a clause tab type what you are looking for (liquidated damages, step-in rights, change in law) and, if you like, limit it to one type of document.",
        },
        {
          question: "Can I remove something from the library?",
          answer: "An administrator can. Ask one if a file was added by mistake.",
        },
      ],
      faqs: [],
    },
    {
      id: "timesheet",
      title: "Timesheet",
      icon: Clock,
      description: "Record your time and download the daily timesheet",
      content: [
        {
          question: "How do I record time?",
          answer:
            "Open Timesheet and press Add entry. The project you used last is already chosen; describe the work and enter the hours. Billable and AK billable hours are optional and can't be more than the hours worked.",
        },
        {
          question: "Can I fill in or fix another day?",
          answer:
            "Yes. Use Previous day and Next day, or pick a date. Click into any box on a row to change it; it saves when you click away. The bin icon deletes an entry after you confirm.",
        },
        {
          question: "How do I get the timesheet file?",
          answer: "Press Download Timesheet (.docx) for the firm's daily timesheet for the day shown, with your name and role.",
        },
        {
          question: "What is Timekeeper?",
          answer:
            "An optional Windows app that tracks time in the background. What it uploads appears here like any other entry; you don't need it.",
        },
      ],
      faqs: [],
    },
    {
      id: "record-meeting",
      title: "Record Meeting",
      icon: Mic,
      description: "Record a meeting and file its minutes, proposal or concept note",
      content: [
        {
          question: "How do I record a meeting?",
          answer:
            "Open Record Meeting (or press Record meeting on the project). Choose the project, the language and the audio source; the page remembers them next time. Press Start, and Stop when the meeting ends. The transcript appears as people speak and tells the speakers apart; click a speaker's name to rename them.",
        },
        {
          question: "How do I get the minutes?",
          answer:
            "Press Generate Minutes, Generate Proposal or Generate Concept Note. The document is saved into the chosen project straight away, dated, and Open in Claude lets you refine it there. Download (.docx) gives you the file as well.",
        },
        {
          question: "I already have a recording or a transcript.",
          answer: "Use Upload recording… or Upload transcript… instead of starting a live meeting.",
        },
        {
          question: "Can it name the speakers from Zoom?",
          answer:
            "Yes, for an online call: choose Microphone + meeting audio, tick Name speakers from Zoom's screen, and press Show where Zoom puts the name once.",
        },
      ],
      faqs: [
        {
          question: "What if I leave the page by mistake?",
          answer:
            "The browser asks first while a recording, a transcript or an unsaved document would be lost. Starting a new meeting over a transcript asks too.",
        },
      ],
    },
    {
      id: "settings",
      title: "Settings",
      icon: Settings,
      description: "Your name, password, sign-in security and less-used pages",
      content: [
        {
          question: "Where are my settings?",
          answer:
            "Press Settings at the bottom of the sidebar. There you can correct your name, change your password, turn two-step sign-in on or off, sign out of every device, and open the less-used pages: Clients, the firm overview, WhatsApp Activity, Team and Document Types.",
        },
        {
          question: "What is two-step sign-in?",
          answer:
            "Signing in with your password and a 6-digit code from an authenticator app on your phone, so someone who learns your password still can't get in.",
        },
        {
          question: "I forgot my password.",
          answer:
            "On the sign-in page press Forgot your password?, enter your email and use the link in the email you receive. If the link has expired, the page offers to send a new one.",
        },
      ],
      faqs: [],
    },
    {
      id: "team-and-types",
      title: "For administrators",
      icon: Users,
      description: "Approvals, roles and the firm's list of document types",
      content: [
        {
          question: "Where are the administrator pages?",
          answer:
            "Under Firm in the sidebar, shown only to administrators: Team, Document Types, Mandate Opportunities (also shown to partners and senior counsel) and WhatsApp Activity. Team shows a number when sign-ups are waiting for approval.",
        },
        {
          question: "How do I approve someone or change a role?",
          answer: "On Team: approve or reject waiting sign-ups at the top, and pick a role from the drop-down next to a name.",
        },
        {
          question: "How do I manage document types?",
          answer:
            "On Document Types, add, rename or delete types, grouped by category. The list drives the types the Hub sets on uploads and the standard Claude drafts from, so rename with care.",
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

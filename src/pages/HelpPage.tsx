import { useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
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

const HelpPage = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("getting-started");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const helpSections: HelpSection[] = [
    {
      id: "getting-started",
      title: "Getting Started",
      icon: BookOpen,
      description: "What AKLA Matter Hub is and how it's organized",
      content: [
        {
          question: "What is AKLA Matter Hub?",
          answer:
            "The firm's internal matter management and AI drafting hub. It tracks PPP transactions and due-diligence engagements through their document lifecycle, and layers AI drafting, redline review, and Q&A on top of the firm's own document history — every AI feature is grounded in matters and precedent that actually exist, not general knowledge alone.",
        },
        {
          question: "How do I navigate the platform?",
          answer:
            "The left sidebar covers the whole app: Dashboard (firm-wide view of every matter), Matters (create and manage transactions), Clients, Team (lawyer directory and roles), Precedent Library (the firm's past agreements), Document Types (the contract taxonomy), and Help. AI drafting, review, and chat are reached from within a matter's workspace rather than the sidebar, since they're always scoped to a specific matter.",
        },
        {
          question: "What are the key features?",
          answer:
            "Matter tracking with a stage checklist and per-document status pipeline; document upload with automatic text extraction and indexing; AI-assisted drafting either from the firm's precedent or a guided intake interview; AI redline review benchmarked against precedent; a per-matter AI chat; and a firm-wide precedent library with an admin-editable document taxonomy.",
        },
        {
          question: "How is data organized?",
          answer:
            "Client → Matter → Documents, Stages, Parties, Tasks, and Notes. Access is firm-wide by design — every lawyer can see and work on every matter, rather than being restricted to matters they're staffed on.",
        },
        {
          question: "How do the AI features work?",
          answer:
            "Anthropic Claude handles drafting, review, and chat; Voyage AI's voyage-law-2 (a legal-domain embedding model) powers retrieval from the firm's documents. AI output is grounded in what's actually been uploaded — drafts mark unknown commercial terms as placeholders (e.g. [CONCESSION PERIOD — TO BE CONFIRMED]) instead of inventing figures, and chat says clearly when nothing relevant is found rather than guessing.",
        },
      ],
      faqs: [
        {
          question: "Do I need to set anything up before using AI features?",
          answer:
            "An administrator needs to add two API keys (ANTHROPIC_API_KEY and VOYAGE_API_KEY) as Edge Function secrets in the Supabase project — a one-time setup step. Matter tracking, document upload, and everything else works without them.",
        },
        {
          question: "Can multiple lawyers work on the same matter?",
          answer:
            "Yes. Firm-wide access means every lawyer can view and edit every matter — there's no per-matter permission to configure.",
        },
      ],
    },
    {
      id: "matters",
      title: "Matters",
      icon: FolderKanban,
      description: "Track a transaction from origination through closing",
      content: [
        {
          question: "How do I create a matter?",
          answer:
            "Go to Matters and click New Matter. Give it a name, and optionally a client, sector, and lead partner. A default stage checklist is seeded automatically for you.",
        },
        {
          question: "What are the default stages?",
          answer:
            "A standard PPP transaction pipeline: Origination, Due Diligence, Drafting, Negotiation, Financial Close, and Post-Closing. Click a stage in the matter workspace to cycle it through not started → in progress → complete.",
        },
        {
          question: "What's in a matter workspace?",
          answer:
            "Stages (the checklist), Documents (every document on the matter with its status), Parties (counterparties like the Grantor, Concessionaire, or EPC Contractor), Tasks (simple to-dos with a checkbox), and Notes (a running activity log).",
          bullets: [
            "Stages — click to advance not started → in progress → complete.",
            "Documents — create a document, upload versions, change status, or launch Draft/Review with AI.",
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
            "Client entities that matters are attached to, managed from the Clients page. A matter doesn't require a client, but linking one lets you filter and gives AI drafting more context.",
        },
      ],
      faqs: [
        {
          question: "Can I restrict a matter to specific lawyers?",
          answer:
            "Not currently — the firm uses firm-wide visibility by design, so there's no per-matter access control to set.",
        },
        {
          question: "Can I edit the stage checklist after a matter is created?",
          answer:
            "Stages seed automatically on creation; there's no UI yet to add or remove stages after the fact.",
        },
      ],
    },
    {
      id: "documents",
      title: "Documents",
      icon: FileText,
      description: "Upload, version, and track documents on a matter",
      content: [
        {
          question: "How do I upload a document?",
          answer:
            "In a matter workspace, use the Documents card: give the document a title and type, then click the upload icon to attach a file as its first version. Uploading again to the same document adds a new version — nothing is overwritten.",
        },
        {
          question: "What happens to a file after I upload it?",
          answer:
            "Its text is extracted (PDF, DOCX, or XLSX) and embedded into the document knowledge base, so it becomes searchable and usable by Ask AI, Draft with AI, and Review with AI on that matter.",
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
          answer: "PDF, DOCX, and XLSX/XLS.",
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
            "From a matter's Documents card, click Draft with AI. Pick a document type and a mode, then follow the flow for that mode.",
        },
        {
          question: "What's the difference between the two modes?",
          answer:
            "From precedent pulls the firm's most recent agreements of that document type plus any known matter parties, and drafts a complete first version in one pass. Guided interview has Claude ask you one question at a time about the key commercial terms — parties, term, payment structure, security, governing law, and so on — until it has enough to draft from your answers.",
        },
        {
          question: "What happens to the draft once it's generated?",
          answer:
            "It loads into an editable rich-text editor — never a locked or final file. Review and edit it before doing anything else with it.",
        },
        {
          question: "How do I save a draft?",
          answer:
            "Click Save as Document Version. This creates (or reuses) a matter document of that type and saves your edited text as a new .docx version.",
        },
        {
          question: "Will the AI invent commercial terms I never gave it?",
          answer:
            "No. Where a specific term wasn't provided, the draft inserts a clearly marked placeholder like [CONCESSION PERIOD — TO BE CONFIRMED] instead of guessing a figure.",
        },
      ],
      faqs: [
        {
          question: "What if there's no precedent for a document type yet?",
          answer:
            "From-precedent mode drafts from standard market practice instead, and the draft itself will say so.",
        },
        {
          question: "Can I keep answering questions across multiple visits?",
          answer:
            "The guided interview is a persisted chat thread, so you can take your time. You can also generate the draft at any point, even before the AI signals it has everything it would ideally want.",
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
            "In the Documents card, a document needs at least one uploaded version. Click the review icon next to it, then Run AI Review.",
        },
        {
          question: "What does the review actually check?",
          answer:
            "It compares the uploaded draft against the firm's precedent for that document type (and standard market practice where no precedent exists), flagging missing standard protections, unusual or one-sided terms, and drafting inconsistencies.",
        },
        {
          question: "How do I act on a suggestion?",
          answer:
            "Accept or Reject each one individually. Nothing is applied to the document automatically — every change is a deliberate choice.",
        },
        {
          question: "How do I get a clean revised document out of this?",
          answer:
            "Click Export Clean Revised Draft. It applies every suggestion you accepted and saves the result as a new document version.",
        },
        {
          question: "Does this produce Word-native tracked changes?",
          answer:
            "Not yet. The current version is in-app accept/reject plus a clean exported .docx — not a file with OOXML revision marks you'd see as tracked changes in Word.",
        },
      ],
      faqs: [
        {
          question: "Can I re-run the review on the same document?",
          answer:
            "Yes. Re-running clears out the old pending suggestions before generating fresh ones, but any suggestions you already accepted or rejected are left alone.",
        },
        {
          question: "I came back later and Export is disabled — why?",
          answer:
            "Export needs the document's extracted text from the same session's review run, which isn't cached across visits yet. Run the review again to re-enable it.",
        },
      ],
    },
    {
      id: "ask-ai",
      title: "Ask AI",
      icon: MessageCircle,
      description: "Chat grounded in a matter's documents and firm precedent",
      content: [
        {
          question: "What is Ask AI?",
          answer:
            "A chat scoped to one matter, grounded in that matter's uploaded documents and the firm-wide precedent library — not general knowledge alone.",
        },
        {
          question: "Where do I find it?",
          answer: "Open a matter's workspace and click Ask AI near the top of the page.",
        },
        {
          question: "Does it remember earlier questions in the same conversation?",
          answer:
            "Yes — within a matter, the conversation persists across turns, so follow-up questions like \"what about the dispute resolution clause\" carry the context of what was already discussed.",
        },
        {
          question: "What happens if it doesn't know the answer?",
          answer:
            "It says so clearly rather than guessing, and distinguishes between something it recalls from the conversation itself versus something it actually found in the knowledge base.",
        },
      ],
      faqs: [],
    },
    {
      id: "precedent-library",
      title: "Precedent Library",
      icon: BookMarked,
      description: "The firm-wide pool of past agreements AI drafting draws from",
      content: [
        {
          question: "What is the Precedent Library?",
          answer:
            "Firm-wide past agreements, independent of any single matter. This is what Draft with AI and Review with AI actually pull from when drafting or benchmarking a document type.",
        },
        {
          question: "How do I add documents to it?",
          answer:
            "Go to Precedent Library, pick a document type, add one or more files, then click Upload. Every file in a batch is tagged with the same document type — run the upload again for a different type.",
        },
        {
          question: "Can I remove something from the library?",
          answer:
            "Yes — deleting a source removes both the underlying file and everything indexed from it.",
        },
        {
          question: "Is precedent tied to a specific matter?",
          answer:
            "No. It's firm-wide and available to every matter that uses a matching document type.",
        },
      ],
      faqs: [
        {
          question: "The library is empty — does anything still work?",
          answer:
            "Yes. Draft with AI falls back to standard market practice, and Review with AI benchmarks against standard practice instead of precedent — both say so explicitly rather than pretending precedent exists.",
        },
      ],
    },
    {
      id: "team-and-types",
      title: "Team & Document Types",
      icon: Users,
      description: "Roles, permissions, and the firm's contract taxonomy",
      content: [
        {
          question: "What roles exist?",
          answer: "Admin, Partner, Associate, and Paralegal.",
        },
        {
          question: "How do I change someone's role?",
          answer:
            "On the Team page, admins can pick a new role from the dropdown next to a lawyer's name. Everyone can view the Team page; only admins can change roles.",
        },
        {
          question: "How do I manage the document taxonomy?",
          answer:
            "On the Document Types page, admins can add, rename, or delete contract types, grouped by category. Everyone can view the list — it drives the type picker in Draft with AI, Review with AI, and document uploads.",
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
            <p className="text-muted-foreground">Learn how to use AKLA Matter Hub</p>
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

      <Card>
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold mb-1">Need more help?</h3>
          <p className="text-muted-foreground mb-4">
            Submit a question and an admin will get back to you.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.target as HTMLFormElement;
              const subject = (form.elements.namedItem("subject") as HTMLInputElement).value.trim();
              const message = (form.elements.namedItem("message") as HTMLTextAreaElement).value.trim();
              if (!subject || !message) return;

              const {
                data: { user },
              } = await supabase.auth.getUser();
              if (!user) return;

              const { error } = await supabase.from("support_requests").insert({
                user_id: user.id,
                subject,
                message,
              });

              if (error) {
                setShowConfirmDialog(false);
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
            <Button type="submit" size="sm">
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
              An admin will follow up as soon as possible.
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

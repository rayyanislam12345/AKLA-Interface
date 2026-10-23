import LegalUpdatesCard from "@/components/dashboard/LegalUpdatesCard";

// The morning legal briefing on a page of its own: what the law monitor
// found in Parliament, the regulators, the PPP authorities and the press,
// and what is still awaiting its official text.
export default function LegalUpdatesPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Legal Updates</h1>
        <p className="text-muted-foreground">
          New and amended laws, checked every morning. The bell at the top right tells you when a law one of your
          projects relies on changes.
        </p>
      </div>
      <LegalUpdatesCard />
    </div>
  );
}

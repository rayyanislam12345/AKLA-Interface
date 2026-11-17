import { FolderSearch } from "lucide-react";
import SharePointSearchTab from "@/components/search/SharePointSearchTab";

// The sidebar's "Search SharePoint": one box over the firm's Data Room. The
// same search is the third tab of "Find a document or clause".
export default function SharePointSearchPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <FolderSearch className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">Search SharePoint</h1>
          <p className="text-muted-foreground">Describe a file and the assistant finds it in the firm's Data Room.</p>
        </div>
      </div>
      <SharePointSearchTab />
    </div>
  );
}

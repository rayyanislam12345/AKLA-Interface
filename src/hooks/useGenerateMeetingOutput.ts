import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Every meeting output is AKLA-format now — "minutes-standard" (a plain
// attendees/decisions/action-items format) was removed as an option.
export type MeetingOutputFormat = "proposal" | "minutes-akla";

export function useGenerateMeetingOutput() {
  return useMutation({
    mutationFn: async ({
      transcriptText,
      format,
      exampleProposals,
    }: {
      transcriptText: string;
      format: MeetingOutputFormat;
      exampleProposals?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("generate-meeting-output", {
        body: { transcriptText, format, exampleProposals },
      });
      if (error) throw error;
      return data as { draft: string };
    },
  });
}

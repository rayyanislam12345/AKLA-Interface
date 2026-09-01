import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type MeetingOutputFormat = "proposal" | "minutes-akla" | "minutes-standard";

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

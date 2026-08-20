export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const emptyResult = (source_name: string, message: string) => ({
  records: [],
  source_name,
  available: false,
  message,
});

export const okResult = (source_name: string, records: unknown[]) => ({
  records,
  source_name,
  available: true,
});

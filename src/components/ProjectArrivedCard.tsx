import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrivedList } from "@/components/ArrivedList";
import { useIntakeActions } from "@/hooks/useIntake";
import { countArrivals } from "@/lib/intake";

const SHOWN = 5;

/**
 * The last few things the Hub filed or noted on this project on its own,
 * each with its Undo. Not shown at all on a project nothing has arrived for.
 */
export function ProjectArrivedCard({ matterId }: { matterId: string | undefined }) {
  const { data: actions } = useIntakeActions({ matterId, limit: 40, enabled: !!matterId });
  const total = useMemo(() => countArrivals(actions ?? []), [actions]);
  if (!matterId || !actions?.length) return null;
  return (
    <Card className="md:col-span-2">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 space-y-0 pb-2">
        <CardTitle className="text-base">Arrived</CardTitle>
        {total > SHOWN && (
          <Link to={`/transactions/arrived?project=${matterId}`} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            See all
          </Link>
        )}
      </CardHeader>
      <CardContent className="px-3 pb-3">
        <ArrivedList actions={actions} compact max={SHOWN} />
      </CardContent>
    </Card>
  );
}

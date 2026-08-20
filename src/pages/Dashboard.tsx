import { useAuth } from "@/hooks/useAuth";

export default function Dashboard() {
  const { user } = useAuth();

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Welcome{user?.email ? `, ${user.email}` : ""}</h1>
      <p className="text-muted-foreground">
        The matter dashboard isn't built yet — this is a placeholder from the Phase 0 foundation pass.
      </p>
    </div>
  );
}

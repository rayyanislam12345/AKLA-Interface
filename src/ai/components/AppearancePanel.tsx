import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useAiWorkspace } from "@/ai/AiWorkspaceContext";
import { AI_THEMES, type AiThemeInfo, enterDarkOnlyMode, isDarkOnlyAiTheme, leaveDarkOnlyMode } from "@/ai/theme";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// The small panel behind "Appearance" in the sidebar's user menu: a theme
// per swatch and the light/dark/system switch. Buttons, not radios, so each
// is reached with Tab and reads its state through aria-pressed.
export default function AppearancePanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { aiTheme, setAiTheme } = useAiWorkspace();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const darkOnly = isDarkOnlyAiTheme(aiTheme);
  // A dark-only theme pins the mode to dark (AiShell keeps it there), so
  // the control shows Dark as the choice even before that effect has run.
  const mode = darkOnly ? "dark" : (theme ?? "system");
  const showingDark = resolvedTheme === "dark" || darkOnly;
  const themeName = AI_THEMES.find((t) => t.id === aiTheme)?.name;

  const choose = (t: AiThemeInfo) => {
    const wasDarkOnly = darkOnly;
    setAiTheme(t.id);
    // Night and Monokai only exist in the dark: always pin the mode (whatever
    // the device says right now), and put the old mode back on leaving.
    if (t.darkOnly) enterDarkOnlyMode(theme, setTheme);
    else if (wasDarkOnly) leaveDarkOnlyMode(setTheme);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="ai-appearance">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription>Colours for the AI workspace. The rest of Project Hub keeps its own.</DialogDescription>
        </DialogHeader>

        <div role="group" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AI_THEMES.map((t) => {
            const selected = t.id === aiTheme;
            const swatch = showingDark || !t.swatch.light ? t.swatch.dark : t.swatch.light;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                onClick={() => choose(t)}
                data-testid={`ai-theme-${t.id}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  selected ? "border-primary bg-accent" : "border-border",
                )}
              >
                <Swatch colors={swatch} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.name}</span>
                  {t.darkOnly && <span className="block text-[11px] text-muted-foreground">Dark only</span>}
                </span>
                <Check className={cn("h-4 w-4 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")} aria-hidden />
              </button>
            );
          })}
        </div>

        <div role="group" aria-label="Light or dark" className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Light or dark</div>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
            <ModeButton active={mode === "light"} disabled={darkOnly} onClick={() => setTheme("light")} icon={<Sun className="h-4 w-4" aria-hidden />} label="Light" />
            <ModeButton active={mode === "dark"} disabled={darkOnly} onClick={() => setTheme("dark")} icon={<Moon className="h-4 w-4" aria-hidden />} label="Dark" />
            <ModeButton active={mode === "system"} disabled={darkOnly} onClick={() => setTheme("system")} icon={<Monitor className="h-4 w-4" aria-hidden />} label="Device" />
          </div>
          {darkOnly && (
            <p className="text-xs text-muted-foreground">
              {themeName} is always dark, so all of Project Hub stays in dark mode while it is chosen. Pick another theme and the mode you had before comes back.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Swatch({ colors }: { colors: [string, string, string] }) {
  return (
    <span className="flex h-7 w-10 shrink-0 overflow-hidden rounded-md border border-border/80" aria-hidden>
      <span className="flex-1" style={{ background: colors[1] }} />
      <span className="relative flex-[2]" style={{ background: colors[0] }}>
        <span className="absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full" style={{ background: colors[2] }} />
      </span>
    </span>
  );
}

function ModeButton({ active, disabled, onClick, icon, label }: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

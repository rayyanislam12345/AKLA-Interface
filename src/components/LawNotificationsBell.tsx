import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, ExternalLink } from "lucide-react";
import {
  useLawNotifications,
  useMarkLawNotificationsRead,
  useNotificationPreferences,
  useSaveNotificationPreferences,
  useUnreadLawNotificationCount,
  type LawNotification,
} from "@/hooks/useLawNotifications";
import { lawUpdateTypeLabel, incorporationLabel } from "@/hooks/useLawUpdates";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

function whenLabel(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function NotificationRow({ item, onOpen }: { item: LawNotification; onOpen: (item: LawNotification) => void }) {
  const update = item.update;
  if (!update) return null;
  const unread = !item.read_at;
  const incorporation = incorporationLabel({ incorporation: update.incorporation, update_type: update.update_type });
  const link = update.document_url || update.source_url;
  return (
    <div className={`px-3 py-2.5 border-b last:border-0 ${unread ? "bg-primary/5" : ""}`}>
      <button type="button" className="text-left w-full" onClick={() => onOpen(item)}>
        <p className="text-xs text-muted-foreground">
          {lawUpdateTypeLabel(update.update_type)}
          {item.matter ? ` · ${item.matter.name}` : " · firm-wide"}
          {` · ${whenLabel(item.created_at)}`}
        </p>
        <p className={`text-sm leading-snug ${unread ? "font-medium" : ""}`}>{update.title}</p>
        {update.act_name && <p className="text-xs text-muted-foreground mt-0.5">Affects {update.act_name}</p>}
        {incorporation && <p className="text-xs text-muted-foreground">{incorporation}</p>}
      </button>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary inline-flex items-center gap-1 hover:underline mt-1"
        >
          Source <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

// The bell in the header. The morning run decides who is told what; this
// only shows it, marks it read, and lets a person switch the firm-wide
// stream and the morning email on or off for themselves.
export function LawNotificationsBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: unread = 0 } = useUnreadLawNotificationCount();
  const { data: items = [] } = useLawNotifications(30);
  const markRead = useMarkLawNotificationsRead();
  const { data: prefs } = useNotificationPreferences();
  const savePrefs = useSaveNotificationPreferences();

  const openItem = (item: LawNotification) => {
    if (!item.read_at) markRead.mutate([item.id]);
    setOpen(false);
    if (item.matter_id) navigate(`/matters/${item.matter_id}`);
    else navigate("/matters#legal-updates");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-white hover:bg-white/10 hover:text-white"
          aria-label={unread > 0 ? `${unread} unread legal updates` : "Legal updates"}
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-accent-foreground text-[10px] font-semibold flex items-center justify-center">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <p className="text-sm font-medium">Legal updates for you</p>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => markRead.mutate(undefined)}>
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground px-3 py-6 text-center">
              Nothing yet. You will be told here when a law one of your projects depends on changes, or when a
              bill or new Act appears.
            </p>
          ) : (
            items.map((item) => <NotificationRow key={item.id} item={item} onOpen={openItem} />)
          )}
        </div>
        <div className="border-t px-3 py-2 space-y-2">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Bills, drafts and new Acts firm-wide</span>
            <Switch
              checked={prefs?.firm_wide_law_updates ?? true}
              onCheckedChange={(v) => savePrefs.mutate({ firm_wide_law_updates: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>Email me each morning there is something new</span>
            <Switch
              checked={prefs?.email_law_updates ?? true}
              onCheckedChange={(v) => savePrefs.mutate({ email_law_updates: v })}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

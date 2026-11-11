import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { TransactionStatusBadge } from "@/components/TransactionStatusBadge";
import type { TransactionRow } from "@/hooks/useTransactions";

interface TransactionRowPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: TransactionRow[];
  onPick: (row: TransactionRow) => void;
  title?: string;
}

/** "It's this row…": a searchable list of the sheet's open rows. */
export function TransactionRowPicker({ open, onOpenChange, rows, onPick, title = "Which row is it?" }: TransactionRowPickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 sm:max-w-lg">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Search by deliverable, client or project.</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search the sheet" />
          <CommandList className="max-h-80">
            <CommandEmpty>No open row matches.</CommandEmpty>
            <CommandGroup>
              {rows.map((row) => (
                <CommandItem
                  key={row.id}
                  value={`${row.deliverable} ${row.client} ${row.project}`}
                  onSelect={() => {
                    onPick(row);
                    onOpenChange(false);
                  }}
                  className="flex items-start justify-between gap-3"
                >
                  <span>
                    <span className="font-medium">{row.deliverable}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.client} · {row.project}
                    </span>
                  </span>
                  <TransactionStatusBadge status={row.status} className="shrink-0 text-[10px]" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

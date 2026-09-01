import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  useDocumentTypes,
  useCreateDocumentType,
  useUpdateDocumentType,
  useDeleteDocumentType,
} from "@/hooks/useMatterDocuments";
import { useProfiles } from "@/hooks/useProfiles";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

export default function DocumentTypesPage() {
  const { user } = useAuth();
  const { data: profiles } = useProfiles();
  const { data: types, isLoading } = useDocumentTypes();
  const createType = useCreateDocumentType();
  const updateType = useUpdateDocumentType();
  const deleteType = useDeleteDocumentType();
  const { toast } = useToast();

  const isAdmin = profiles?.find((p) => p.id === user?.id)?.role === "admin";

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");

  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");

  const grouped = types?.reduce<Record<string, typeof types>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  const handleCreate = async () => {
    if (!newName.trim() || !newCategory.trim()) return;
    try {
      await createType.mutateAsync({ name: newName.trim(), category: newCategory.trim() });
      toast({ title: "Document type created" });
      setNewOpen(false);
      setNewName("");
      setNewCategory("");
    } catch (e: any) {
      toast({ title: "Failed to create", description: e.message, variant: "destructive" });
    }
  };

  const openEdit = (id: string, name: string, category: string) => {
    setEditId(id);
    setEditName(name);
    setEditCategory(category);
  };

  const handleUpdate = async () => {
    if (!editId || !editName.trim() || !editCategory.trim()) return;
    try {
      await updateType.mutateAsync({ id: editId, name: editName.trim(), category: editCategory.trim() });
      toast({ title: "Document type updated" });
      setEditId(null);
    } catch (e: any) {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    try {
      await deleteType.mutateAsync(id);
      toast({ title: "Document type deleted" });
    } catch (e: any) {
      toast({
        title: "Failed to delete",
        description: "This type is likely still in use by a matter document.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Document Types</h1>
          <p className="text-muted-foreground">The firm's contract taxonomy, used across drafting and review.</p>
        </div>
        {isAdmin && (
          <Dialog open={newOpen} onOpenChange={setNewOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Type
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New Document Type</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="new-type-name">Name</Label>
                  <Input id="new-type-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-type-category">Category</Label>
                  <Input
                    id="new-type-category"
                    placeholder="e.g. Financing & Security"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={!newName.trim() || !newCategory.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        Object.entries(grouped ?? {}).map(([category, items]) => (
          <div key={category} className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{category}</h2>

            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    {isAdmin && <TableHead className="w-24">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items!.map((type) => (
                    <TableRow key={type.id}>
                      <TableCell>{type.name}</TableCell>
                      {isAdmin && (
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => openEdit(type.id, type.name, type.category)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => handleDelete(type.id, type.name)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="sm:hidden space-y-2">
              {items!.map((type) => (
                <div key={type.id} className="flex items-center justify-between gap-2 border rounded-md px-3 py-2">
                  <p className="text-sm truncate">{type.name}</p>
                  {isAdmin && (
                    <div className="flex gap-1 shrink-0">
                      <Button size="icon" variant="ghost" onClick={() => openEdit(type.id, type.name, type.category)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => handleDelete(type.id, type.name)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <Dialog open={!!editId} onOpenChange={(open) => !open && setEditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Document Type</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-type-name">Name</Label>
              <Input id="edit-type-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-type-category">Category</Label>
              <Input id="edit-type-category" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleUpdate} disabled={!editName.trim() || !editCategory.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

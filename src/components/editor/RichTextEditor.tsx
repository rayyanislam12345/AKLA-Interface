import { forwardRef, useEffect, useImperativeHandle } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

interface RichTextEditorProps {
  content: string;
  onChange?: (html: string) => void;
  editable?: boolean;
  className?: string;
}

// Wraps the TipTap editor used both for AI-generated drafts and for
// standard-version editing. Exposes the underlying Editor instance via ref
// so callers that need ProseMirror JSON (e.g. the Draft panel's docx
// export via lib/firmDocx.ts) can still get at it directly.
const RichTextEditor = forwardRef<Editor | null, RichTextEditorProps>(
  ({ content, onChange, editable = true, className }, ref) => {
    const editor = useEditor({
      extensions: [StarterKit],
      content,
      editable,
      onUpdate: ({ editor }) => onChange?.(editor.getHTML()),
    });

    useImperativeHandle(ref, () => editor, [editor]);

    useEffect(() => {
      if (editor && content !== editor.getHTML()) {
        editor.commands.setContent(content);
      }
      // Only re-sync when `content` changes externally — including `editor`
      // here would re-run on every keystroke and fight the user's typing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content]);

    return (
      <div className={className ?? "border rounded-md p-4 prose prose-sm max-w-none min-h-[400px]"}>
        <EditorContent editor={editor} />
      </div>
    );
  }
);
RichTextEditor.displayName = "RichTextEditor";

export default RichTextEditor;

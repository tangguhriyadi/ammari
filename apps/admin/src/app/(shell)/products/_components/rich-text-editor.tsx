"use client";

import { useId } from "react";
import { Bold, Italic, List, ListOrdered } from "lucide-react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold as BoldExtension } from "@tiptap/extension-bold";
import { Italic as ItalicExtension } from "@tiptap/extension-italic";
import { BulletList } from "@tiptap/extension-bullet-list";
import { OrderedList } from "@tiptap/extension-ordered-list";
import { ListItem } from "@tiptap/extension-list-item";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Label, FieldError, cn } from "@ammari/ui";

// docs/plans/storefront-cms.md ("Storefront description: rich-text editor + sanitization") —
// composed from individual extension packages, NOT @tiptap/starter-kit: StarterKit (TipTap v3)
// bundles far more than the plan's 9 allowed node/mark types (Heading, Blockquote, CodeBlock,
// HorizontalRule, Strike, inline Code, Link, Underline, ...), and every one of those would need
// to be explicitly turned back off via `.configure({ ... : false })`. Depending on only the
// extensions actually wanted means there is nothing to misconfigure — an extension that was
// never imported can never end up in the document, full stop. The server-side sanitizer
// (@ammari/content-sanitize) is still the real security boundary on save/render; this list is
// what keeps the EDITING experience itself matching "paragraphs, bold, italic, lists only" with
// no toolbar buttons or keyboard shortcuts for anything else to begin with.
const EXTENSIONS = [Document, Paragraph, Text, BoldExtension, ItalicExtension, BulletList, OrderedList, ListItem, HardBreak];

function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // The button itself is the >=44px touch target (iPhone/iPad Safari — no hover-only
      // affordance, no keyboard-shortcut-only path to any of these 4 commands: every one is
      // reachable by tapping this button alone). onMouseDown+preventDefault, not onClick, is
      // what keeps the editor's own text selection from collapsing before the toggle command
      // runs — a real behavioral difference on touch devices, not just a desktop nicety.
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-md border",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
        active ? "border-brand bg-brand/10 text-brand" : "border-neutral-300 bg-white text-neutral-700",
      )}
    >
      {children}
    </button>
  );
}

export interface RichTextEditorProps {
  id?: string;
  label: string;
  content: string;
  onChange: (html: string) => void;
  error?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

/** TipTap's contentEditable-based editor, restricted to paragraphs/bold/italic/bulleted+numbered
 * lists — the admin-only "Deskripsi untuk toko" editor (docs/plans/storefront-cms.md). Never
 * bundled into apps/web: the storefront only ever renders the already-sanitized HTML string via
 * a plain safe-render helper, with no editor code at all. */
export function RichTextEditor({ id, label, content, onChange, error, disabled, ...props }: RichTextEditorProps) {
  const autoId = useId();
  const editorId = id ?? autoId;
  const errorId = `${editorId}-error`;
  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: updatedEditor }) => onChange(updatedEditor.getHTML()),
  });

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label htmlFor={editorId}>{label}</Label>}
      <div className={cn("rounded-md border border-neutral-500", error && "border-danger-700")}>
        <Toolbar editor={editor} />
        <EditorContent
          id={editorId}
          editor={editor}
          data-testid={props["data-testid"]}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "min-h-32 px-3 py-2 text-base text-neutral-900",
            "[&_.ProseMirror]:min-h-28 [&_.ProseMirror]:outline-none",
            "[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5",
            "[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5",
          )}
        />
      </div>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-neutral-200 p-1">
      <ToolbarButton
        label="Tebal"
        active={editor?.isActive("bold") ?? false}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold className="size-4" aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Miring"
        active={editor?.isActive("italic") ?? false}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-4" aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Daftar bullet"
        active={editor?.isActive("bulletList") ?? false}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List className="size-4" aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton
        label="Daftar bernomor"
        active={editor?.isActive("orderedList") ?? false}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-4" aria-hidden="true" />
      </ToolbarButton>
    </div>
  );
}

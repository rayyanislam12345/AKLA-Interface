import { Node, mergeAttributes } from "@tiptap/react";

// Preserve tables from AI Markdown through editor saves and Word exports.
export const TableNode = Node.create({
  name: "table", group: "block", content: "tableRow+", isolating: true,
  parseHTML: () => [{ tag: "table" }],
  renderHTML: ({ HTMLAttributes }) => ["table", mergeAttributes(HTMLAttributes, { class: "border-collapse border w-full" }), ["tbody", 0]],
});
export const TableRowNode = Node.create({
  name: "tableRow", content: "(tableCell | tableHeader)+",
  parseHTML: () => [{ tag: "tr" }], renderHTML: () => ["tr", 0],
});
const cellAttributes = () => ({
  colspan: { default: 1, parseHTML: (el: HTMLElement) => Math.max(1, Number(el.getAttribute("colspan")) || 1) },
  rowspan: { default: 1, parseHTML: (el: HTMLElement) => Math.max(1, Number(el.getAttribute("rowspan")) || 1) },
});
export const TableCellNode = Node.create({
  name: "tableCell", content: "block+", isolating: true, addAttributes: cellAttributes,
  parseHTML: () => [{ tag: "td" }], renderHTML: ({ HTMLAttributes }) => ["td", mergeAttributes(HTMLAttributes, { class: "border p-2 align-top" }), 0],
});
export const TableHeaderNode = Node.create({
  name: "tableHeader", content: "block+", isolating: true, addAttributes: cellAttributes,
  parseHTML: () => [{ tag: "th" }], renderHTML: ({ HTMLAttributes }) => ["th", mergeAttributes(HTMLAttributes, { class: "border p-2 align-top font-bold" }), 0],
});

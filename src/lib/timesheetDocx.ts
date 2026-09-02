import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

// Reproduces timesheet-sample/Timesheet sample.docx exactly: A4 page, 1"
// margins, Arial throughout, navy (#002060) header row with gold (#FFC000)
// bold text, "Table Grid"-style single black borders, and the same column
// widths (in twips, lifted straight from the sample's own tblGrid). One row
// per timeslip entry — the exported doc mirrors the editable on-page table
// exactly, so no day-grouping/consolidation happens here.

export interface TimesheetEntryRow {
  srNo: number;
  matterName: string;
  description: string;
  hours: number;
  billableHours: number | null;
  akBillableHours: number | null;
}

const pt = (points: number) => points * 2; // docx sizes are in half-points
const NAVY = "002060";
const GOLD = "FFC000";
const COLUMN_WIDTHS = [774, 1932, 2664, 1158, 1287, 1206]; // Sr.No, Transaction, Matter & Description, Hours, Billable Hours, AK Billable Hours

const cellBorders = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: "000000",
} as const;

const tableBorders = {
  top: cellBorders,
  bottom: cellBorders,
  left: cellBorders,
  right: cellBorders,
  insideHorizontal: cellBorders,
  insideVertical: cellBorders,
};

// TextRun's `break` prefixes a line break before the run's own text, so the
// first line of a multi-line header needs break omitted and every
// subsequent line needs it set.
function headerParagraph(lines: string[]) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: lines.map(
      (line, i) =>
        new TextRun({
          text: line,
          break: i > 0 ? 1 : undefined,
          bold: true,
          color: GOLD,
          size: pt(12),
          font: "Arial",
        })
    ),
  });
}

function headerRow() {
  const cols: string[][] = [
    ["Sr. No."],
    ["Transaction"],
    ["Matter &", "Description"],
    ["Hours"],
    ["Billable Hours"],
    ["AK", "Billable Hours"],
  ];
  return new TableRow({
    tableHeader: true,
    children: cols.map(
      (lines) =>
        new TableCell({
          shading: { fill: NAVY, type: ShadingType.CLEAR },
          children: [headerParagraph(lines)],
        })
    ),
  });
}

function bodyParagraph(text: string, alignment: (typeof AlignmentType)[keyof typeof AlignmentType], bold = false) {
  // Description narratives are joined with a blank line between entries
  // (matching the sample's own "task 1; and\n\ntask 2" formatting) — split
  // on \n and re-join as explicit line breaks so they render inside one
  // table cell instead of collapsing to a single line.
  const lines = text.split("\n");
  const children: TextRun[] = [];
  lines.forEach((line, i) => {
    children.push(new TextRun({ text: line, bold, font: "Arial", size: pt(11), break: i > 0 ? 1 : undefined }));
  });
  return new Paragraph({ alignment, children });
}

function hoursOrDash(value: number | null) {
  return value === null || Number.isNaN(value) ? "-" : value.toFixed(1);
}

function dataRow(row: TimesheetEntryRow) {
  return new TableRow({
    children: [
      new TableCell({ children: [bodyParagraph(String(row.srNo), AlignmentType.CENTER)] }),
      new TableCell({ children: [bodyParagraph(row.matterName, AlignmentType.LEFT)] }),
      new TableCell({ children: [bodyParagraph(row.description, AlignmentType.JUSTIFIED)] }),
      new TableCell({ children: [bodyParagraph(row.hours.toFixed(1), AlignmentType.CENTER)] }),
      new TableCell({ children: [bodyParagraph(hoursOrDash(row.billableHours), AlignmentType.CENTER)] }),
      new TableCell({ children: [bodyParagraph(hoursOrDash(row.akBillableHours), AlignmentType.CENTER)] }),
    ],
  });
}

function totalRow(totalHours: number) {
  return new TableRow({
    children: [
      new TableCell({ columnSpan: 3, children: [bodyParagraph("Total Hours", AlignmentType.CENTER)] }),
      new TableCell({ children: [bodyParagraph(totalHours.toFixed(1), AlignmentType.CENTER)] }),
      new TableCell({ children: [bodyParagraph("-", AlignmentType.CENTER)] }),
      new TableCell({ children: [bodyParagraph("-", AlignmentType.CENTER)] }),
    ],
  });
}

function formatDateLabel(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric" });
}

export async function buildTimesheetDocxBlob(
  date: string,
  rows: TimesheetEntryRow[],
  roleLabel: string,
  employeeName: string
): Promise<Blob> {
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: COLUMN_WIDTHS,
    borders: tableBorders,
    rows: [headerRow(), ...rows.map(dataRow), totalRow(totalHours)],
  });

  const children: (Paragraph | Table)[] = [
    new Paragraph({ children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Daily Timesheet", bold: true, font: "Arial", size: pt(13) })],
    }),
    new Paragraph({ children: [] }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: "Date: ", bold: true, font: "Arial" }),
        new TextRun({ text: formatDateLabel(date), font: "Arial" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: `${roleLabel}: `, bold: true, font: "Arial" }),
        new TextRun({ text: employeeName, font: "Arial" }),
      ],
    }),
    new Paragraph({ children: [] }),
    table,
    new Paragraph({ children: [] }),
    new Paragraph({
      children: [new TextRun({ text: "[*** The Rest Of This Page Has Been Intentionally Left Blank***]" })],
    }),
  ];

  const doc = new Document({
    title: "Daily Timesheet",
    styles: {
      default: {
        document: { run: { font: "Arial", size: pt(11) } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4, matches the sample exactly
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}

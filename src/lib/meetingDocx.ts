import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

// Ported verbatim from transcription-bot/src/markdownToDocx.js. All meeting
// output (proposals and minutes alike) uses this single "AKLA" house style —
// the plain firm-formatting-guide style this file used to also export
// (buildStandardDocxBlob, for a since-removed standard-minutes option) is
// gone; DraftDocumentPage's firmNumberingConfig is unrelated to either.

const pt = (points: number) => points * 2; // docx sizes are in half-points

interface RunSpec {
  text: string;
  bold?: boolean;
  italics?: boolean;
}

function parseInlineRuns(text: string): RunSpec[] {
  const runs: RunSpec[] = [];
  const pattern = /(\*\*.+?\*\*|\*.+?\*|_.+?_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push({ text: token.slice(2, -2), bold: true });
    } else {
      runs.push({ text: token.slice(1, -1), italics: true });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex) });
  }
  return runs.length ? runs : [{ text }];
}

// AKLA format: a legal-memo outline (navy/gold title banner, real 3-level
// legal numbering, red internal-use header) — used for proposals and
// AKLA-format minutes.
export async function buildAklaDocxBlob(markdown: string, title?: string): Promise<Blob> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const paragraphs: Paragraph[] = [];
  let docTitle = title || "Notes";
  let titleParagraph: Paragraph | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const noticeMatch = /^>\s+(.*)$/.exec(line);
    if (noticeMatch) {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 200 },
          children: parseInlineRuns(noticeMatch[1]).map((r) => new TextRun({ ...r, bold: true })),
        })
      );
      continue;
    }

    const titleMatch = /^#\s+(.*)$/.exec(line);
    if (titleMatch) {
      docTitle = titleMatch[1];
      titleParagraph = new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: parseInlineRuns(titleMatch[1]).map(
          (r) => new TextRun({ ...r, smallCaps: true, color: "FFC000", size: pt(13) })
        ),
      });
      continue;
    }

    const level0Match = /^##\s+(.*)$/.exec(line);
    if (level0Match) {
      paragraphs.push(
        new Paragraph({
          numbering: { reference: "akla-outline", level: 0 },
          alignment: AlignmentType.BOTH,
          spacing: { after: 0 },
          children: parseInlineRuns(level0Match[1]).map(
            (r) => new TextRun({ ...r, bold: true, smallCaps: true, underline: {} })
          ),
        })
      );
      paragraphs.push(new Paragraph({ alignment: AlignmentType.BOTH, children: [] }));
      continue;
    }

    const level1Match = /^###\s+(.*)$/.exec(line);
    if (level1Match) {
      paragraphs.push(
        new Paragraph({
          numbering: { reference: "akla-outline", level: 1 },
          alignment: AlignmentType.BOTH,
          spacing: { after: 0 },
          children: parseInlineRuns(level1Match[1]).map((r) => new TextRun({ ...r, smallCaps: true, underline: {} })),
        })
      );
      paragraphs.push(new Paragraph({ alignment: AlignmentType.BOTH, children: [] }));
      continue;
    }

    paragraphs.push(
      new Paragraph({
        numbering: { reference: "akla-outline", level: 2 },
        alignment: AlignmentType.BOTH,
        spacing: { after: 0 },
        children: parseInlineRuns(line).map((r) => new TextRun(r)),
      })
    );
    paragraphs.push(new Paragraph({ alignment: AlignmentType.BOTH, children: [] }));
  }

  if (!titleParagraph) {
    titleParagraph = new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: docTitle, smallCaps: true, color: "FFC000", size: pt(13) })],
    });
  }

  const noBorder = { style: BorderStyle.NONE, size: 0, color: "auto" } as const;
  const titleBanner = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: noBorder,
      bottom: noBorder,
      left: noBorder,
      right: noBorder,
      insideHorizontal: noBorder,
      insideVertical: noBorder,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "002060", type: ShadingType.CLEAR },
            margins: { top: 288, bottom: 288, left: 100, right: 100 },
            children: [titleParagraph],
          }),
        ],
      }),
    ],
  });

  const level0Style = { paragraph: { indent: { left: 720, hanging: 360 } } };
  const subLevelStyle = { paragraph: { indent: { left: 1080, hanging: 720 } } };

  const todayLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const doc = new Document({
    title: docTitle,
    styles: {
      default: {
        document: { run: { font: "Arial", size: pt(11) } },
      },
    },
    numbering: {
      config: [
        {
          reference: "akla-outline",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              isLegalNumberingStyle: true,
              style: level0Style,
            },
            {
              level: 1,
              format: LevelFormat.DECIMAL,
              text: "%1.%2.",
              alignment: AlignmentType.LEFT,
              isLegalNumberingStyle: true,
              style: subLevelStyle,
            },
            {
              level: 2,
              format: LevelFormat.DECIMAL,
              text: "%1.%2.%3.",
              alignment: AlignmentType.LEFT,
              isLegalNumberingStyle: true,
              style: subLevelStyle,
            },
          ],
        },
      ],
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.BOTH,
                spacing: { after: 0 },
                children: [
                  new TextRun({ text: `${docTitle} — AKLA — First Draft`, bold: true, smallCaps: true, size: pt(8) }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.BOTH,
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: `For Internal Purposes Only — ${todayLabel}`,
                    smallCaps: true,
                    size: pt(8),
                    color: "EE0000",
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    font: "Arial",
                    size: pt(8),
                    children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
                  }),
                ],
              }),
            ],
          }),
        },
        children: [titleBanner, new Paragraph({ spacing: { after: 0 }, children: [] }), ...paragraphs],
      },
    ],
  });

  return Packer.toBlob(doc);
}

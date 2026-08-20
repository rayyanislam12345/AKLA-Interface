import { Buffer } from "node:buffer";

export interface ExtractResult {
  text: string;
  metadata: Record<string, unknown>;
}

export async function extractTextFromFile(fileData: Blob, fileName: string): Promise<ExtractResult> {
  const fileExtension = fileName.toLowerCase().split(".").pop();

  if (fileExtension === "pdf") {
    const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.11.0");
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const documentProxy = await getDocumentProxy(uint8Array);
    const numPages = documentProxy.numPages;
    const { text } = await extractText(uint8Array, { mergePages: true });
    return { text, metadata: { page_count: numPages, original_format: "pdf" } };
  }

  if (fileExtension === "docx") {
    const mammoth = await import("https://esm.sh/mammoth@1.6.0");
    const arrayBuffer = await fileData.arrayBuffer();
    // esm.sh can resolve either mammoth's browser build (wants `arrayBuffer`)
    // or its Node build (wants a Node `buffer`) depending on how it infers
    // the target — pass both so extraction works regardless of which loads.
    const result = await mammoth.extractRawText({ arrayBuffer, buffer: Buffer.from(arrayBuffer) } as any);
    return { text: result.value, metadata: { original_format: "docx" } };
  }

  if (fileExtension === "xlsx" || fileExtension === "xls") {
    const XLSX = await import("https://esm.sh/xlsx@0.18.5");
    const arrayBuffer = await fileData.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    const sheets: string[] = [];

    workbook.SheetNames.forEach((sheetName: string) => {
      const worksheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      let sheetText = `[Sheet: ${sheetName}]\n`;
      sheetData.forEach((row: any, index: number) => {
        if (row && row.length > 0) {
          sheetText += `Row ${index + 1}: ${row.join(", ")}\n`;
        }
      });
      sheets.push(sheetText);
    });

    return {
      text: sheets.join("\n\n"),
      metadata: { sheet_count: workbook.SheetNames.length, original_format: "excel" },
    };
  }

  throw new Error(`Unsupported file type: ${fileExtension}`);
}

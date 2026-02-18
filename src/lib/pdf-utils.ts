import { PDFDocument, rgb, StandardFonts, PDFFont } from "pdf-lib";

export interface PdfAnnotation {
  id: string;
  type: "text" | "rect" | "image" | "path" | "text-replace";
  page: number; // 1-based index
  x: number;
  y: number;
  text?: string;
  fontSize?: number;
  width?: number;
  height?: number;
  image?: string; 
  path?: string; 
  strokeWidth?: number;
  color?: string;
  // Specific for text-replace
  originalTextRect?: { x: number; y: number; width: number; height: number };
}

export async function modifyPdf(
  file: File, 
  annotations: PdfAnnotation[],
  deletedPageIndices: number[] = []
): Promise<Uint8Array> {
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  
  const pages = pdfDoc.getPages();
  
  // Parse color helper
  const parseColor = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      return rgb(isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b);
  }

  for (const ann of annotations) {
    if (ann.page > pages.length || deletedPageIndices.includes(ann.page - 1)) continue;
    
    const page = pages[ann.page - 1];
    const { height } = page.getSize();

    if (ann.type === "text-replace" && ann.originalTextRect && ann.text) {
        // 1. Redact original text (White rectangle)
        // PDF-lib coordinates are bottom-left. We must flip the Y.
        // The rect comes in as PDF coordinates (already flipped by frontend)
        page.drawRectangle({
            x: ann.originalTextRect.x,
            y: ann.originalTextRect.y, // Expecting PDF coords from frontend
            width: ann.originalTextRect.width,
            height: ann.originalTextRect.height,
            color: rgb(1, 1, 1), // White mask
        });

        // 2. Draw new text
        page.drawText(ann.text, {
            x: ann.x,
            y: ann.y, // Expecting PDF coords
            size: ann.fontSize || 12,
            font: helveticaFont, // Defaulting to Helvetica for stability
            color: parseColor(ann.color || "#000000"),
        });
        continue;
    }

    // ... [Existing Logic for other types remains the same] ...
    if (ann.type === "text" && ann.text) {
      page.drawText(ann.text, {
        x: ann.x,
        y: height - ann.y, 
        size: ann.fontSize || 12,
        font: helveticaFont,
        color: parseColor(ann.color || "#000000"),
      });
    }

    if (ann.type === "rect" && ann.width && ann.height) {
      page.drawRectangle({
        x: ann.x,
        y: height - ann.y - ann.height, 
        width: ann.width,
        height: ann.height,
        color: parseColor(ann.color || "#ffff00"), 
        opacity: 0.4,
      });
    }

    if (ann.type === "image" && ann.image && ann.width && ann.height) {
        try {
            const imgBytes = Uint8Array.from(atob(ann.image.split(',')[1]), c => c.charCodeAt(0));
            const isPng = ann.image.startsWith("data:image/png");
            const embeddedImage = isPng 
                ? await pdfDoc.embedPng(imgBytes) 
                : await pdfDoc.embedJpg(imgBytes);
            
            page.drawImage(embeddedImage, {
                x: ann.x,
                y: height - ann.y - ann.height,
                width: ann.width,
                height: ann.height,
            });
        } catch(e) { console.error("Failed to embed image", e); }
    }

    if (ann.type === "path" && ann.path) {
        page.drawSvgPath(ann.path, {
            x: ann.x,
            y: height - ann.y,
            borderColor: parseColor(ann.color || "#000000"),
            borderWidth: ann.strokeWidth || 2,
        });
    }
  }

  // Handle Page Deletion
  const sortedDeletions = [...deletedPageIndices].sort((a, b) => b - a);
  for (const idx of sortedDeletions) {
      if (idx < pdfDoc.getPageCount()) {
          pdfDoc.removePage(idx);
      }
  }

  return await pdfDoc.save();
}

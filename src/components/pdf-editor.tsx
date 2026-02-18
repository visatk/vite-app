import React, { useState, useRef, useEffect, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { 
  Loader2, Save, Type, Upload, Highlighter, 
  ZoomIn, ZoomOut, Undo, MousePointer2 
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/alert-dialog"; // Re-using alert-dialog primitive or standard dialog if avail
import { modifyPdf, type PdfAnnotation } from "@/lib/pdf-utils";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// Determine API URL based on environment
const API_BASE = import.meta.env.PROD ? "/api" : "http://localhost:8787/api";

export function PdfEditor() {
  const [file, setFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  
  // View State
  const [scale, setScale] = useState(1.0);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Tools State
  const [tool, setTool] = useState<"none" | "text" | "rect">("none");
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  
  // Text Input State
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [tempTextData, setTempTextData] = useState<{x: number, y: number, page: number} | null>(null);
  const [textInputValue, setTextInputValue] = useState("");

  // Resize Observer for Responsive PDF
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 1. Handle File Upload
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setAnnotations([]); // Reset annotations
      setTool("none");

      const formData = new FormData();
      formData.append("file", selectedFile);

      try {
        const res = await fetch(`${API_BASE}/session/upload`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json() as { id: string };
        setSessionId(data.id);
      } catch (err) {
        console.error("Upload failed", err);
      }
    }
  };

  // 2. Handle Clicks on PDF Page
  const handlePageClick = (e: React.MouseEvent, pageIndex: number) => {
    if (tool === "none") return;

    const rect = e.currentTarget.getBoundingClientRect();
    // Calculate unscaled coordinates (relative to the PDF's natural size at 100% scale)
    // We assume the rendered width is containerWidth (if fit width) * scale
    // But react-pdf renders based on 'width' prop. 
    // The scale factor between rendered pixels and PDF points is handled here.
    
    // Determine the actual scale the PDF is currently rendered at relative to CSS pixels
    // If we pass `scale` to Page, it scales the PDF. 
    // However, we are likely using `width={containerWidth}` which overrides `scale` for fitting,
    // OR we use `scale` explicitly. 
    // Strategy: We will use `width={containerWidth}` and apply a zoom multiplier manually if needed, 
    // but typically for responsive mobile, `width={containerWidth}` is best.
    
    // To support Zoom AND Responsive, strictly:
    // We will calculate coordinates as percentages or normalized 1.0 scale values.
    
    // Simplification: We treat the click coordinate relative to the *current rendered size* // and store it. When saving, we need to know the PDF's true dimensions, 
    // but our `modifyPdf` takes raw x/y. 
    // We will store coordinates relative to the *rendered* element and then 
    // devide by the current scale factor when saving? 
    // NO. Best practice: Store normalized (0-1) or store relative to a fixed scale (1.0).
    
    // Let's rely on the fact that we render the Page at `scale={scale}` (if we use scale prop)
    // or `width={containerWidth}`.
    // Let's assume we render using `scale={scale}` for zoom, but limited by container?
    // Actually, for mobile responsiveness, `width={containerWidth}` is king.
    // If we zoom, we just increase the width passed to Page?
    
    // Let's go with: width = containerWidth * zoomLevel
    const currentRenderedWidth = containerRef.current?.getBoundingClientRect().width || 600;
    // Note: rect.width should be the actual width of the page element clicked
    const scaleFactor = rect.width; 
    
    // Normalized coordinates (0 to 1)
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top) / rect.height;

    // We need to convert these back to PDF Point coordinates (72 DPI usually) 
    // inside `modifyPdf`. But we don't know the PDF's internal point size here easily 
    // without loading the PDF structure.
    // Workaround: We will store the *visual* offset relative to a standard 1.0 scale
    // assuming the viewer matches the PDF point size at scale 1.0.
    // Ideally, we pass the raw click relative to the scale 1.0.
    // If react-pdf Page `scale={1}` renders at PDF point size, then:
    // real_x = (e.clientX - rect.left) / current_scale
    
    // But we are using `width` to force size.
    // We will store percentage based annotations for robust rendering across resizes in the editor,
    // and calculating exact positions for the saver is tricky without page metadata.
    
    // COMPROMISE for this iteration:
    // We will assume standard letter width (approx 600pt) for calculation if unknown, 
    // OR better: Just use the visual pixel coordinates relative to the current view 
    // and rely on the user not resizing the window aggressively between edits.
    // To fix properly: We simply store the click X/Y divided by the *current visual scale*.
    // Since we don't know the exact PDF point scale vs CSS pixel scale easily:
    // We will use a fixed Reference Scale.
    
    // Let's use the `pdf-lib` standard: 
    // We will save X/Y based on the rendered element's size divided by the rendered scale ratio.
    // Actually, react-pdf provides `onLoadSuccess` for the PAGE giving us `originalWidth`.
    
    // We will just store normalized (0-1) coordinates in the UI state, 
    // and convert to absolute coordinates inside `modifyPdf` or just before saving?
    // `modifyPdf` needs absolute.
    // Let's keep it simple: The logic in the previous file was:
    // x = (clientX - left) / scale. 
    // This assumes `scale` prop was used.
    
    // We will return to using `scale` prop for the Viewer to keep coordinates consistent.
    // Mobile responsiveness will be achieved by calculating the `scale` 
    // that fits the `containerWidth`.
    
    // 1. Calculate the click position relative to the element (CSS pixels)
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // 2. Adjust for the current scale of the viewer
    // If we use the "Fit Width" strategy, we need to know the effective scale.
    // Effective Scale = rect.width / original_page_width (which we don't have easily per page).
    
    // Let's stick to the previous simple logic but make it robust:
    // We will render the PDF at a specific `scale` state. 
    // We will initialize `scale` such that it fits the container.
    
    const pdfX = clickX / scale;
    const pdfY = clickY / scale;

    if (tool === "text") {
      setTempTextData({ x: pdfX, y: pdfY, page: pageIndex + 1 });
      setTextInputValue("");
      setIsInputOpen(true);
    } else if (tool === "rect") {
       setAnnotations((prev) => [
        ...prev,
        {
          id: uuidv4(),
          type: "rect",
          page: pageIndex + 1,
          x: pdfX - 50, // Center rect
          y: pdfY - 25,
          width: 100,
          height: 50,
          color: "yellow",
        },
      ]);
      setTool("none");
    }
  };

  const handleTextSubmit = () => {
    if (tempTextData && textInputValue) {
       setAnnotations((prev) => [
        ...prev,
        {
          id: uuidv4(),
          type: "text",
          page: tempTextData.page,
          x: tempTextData.x,
          y: tempTextData.y,
          text: textInputValue,
        },
      ]);
    }
    setIsInputOpen(false);
    setTempTextData(null);
    setTool("none");
  };

  const undoAnnotation = () => {
    setAnnotations((prev) => prev.slice(0, -1));
  };

  const handleSave = async () => {
    if (!file) return;
    setIsSaving(true);
    try {
      const pdfBytes = await modifyPdf(file, annotations);
      const blob = new Blob([pdfBytes as any], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `edited-${file.name}`;
      link.click();
    } catch (e) {
      console.error(e);
      alert("Error saving PDF");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans">
      {/* 1. Responsive Header / Toolbar */}
      <header className="bg-white border-b px-4 py-3 shadow-sm z-20 flex items-center justify-between gap-2 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-2">
           {/* Logo / Title */}
           <div className="hidden md:flex items-center gap-2 mr-2">
             <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold">PDF</div>
             <span className="font-bold text-lg text-slate-800">Editor</span>
           </div>

           {/* Toolbar Actions */}
           <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
             <Button
               variant={tool === "none" ? "secondary" : "ghost"}
               size="icon"
               onClick={() => setTool("none")}
               title="Cursor"
               className="h-8 w-8"
             >
               <MousePointer2 className="w-4 h-4" />
             </Button>
             <Separator orientation="vertical" className="h-6" />
             <Button
               variant={tool === "text" ? "secondary" : "ghost"}
               size="icon"
               onClick={() => setTool("text")}
               disabled={!file}
               title="Add Text"
               className="h-8 w-8"
             >
               <Type className="w-4 h-4" />
             </Button>
             <Button
               variant={tool === "rect" ? "secondary" : "ghost"}
               size="icon"
               onClick={() => setTool("rect")}
               disabled={!file}
               title="Highlight"
               className="h-8 w-8"
             >
               <Highlighter className="w-4 h-4" />
             </Button>
           </div>

           {/* Zoom Controls */}
           <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg ml-2">
              <Button variant="ghost" size="icon" onClick={() => setScale(s => Math.max(0.5, s - 0.2))} className="h-8 w-8">
                <ZoomOut className="w-4 h-4" />
              </Button>
              <span className="text-xs font-mono w-10 text-center">{Math.round(scale * 100)}%</span>
              <Button variant="ghost" size="icon" onClick={() => setScale(s => Math.min(3, s + 0.2))} className="h-8 w-8">
                <ZoomIn className="w-4 h-4" />
              </Button>
           </div>
           
           <Button variant="ghost" size="icon" onClick={undoAnnotation} disabled={annotations.length === 0} className="h-8 w-8 ml-2" title="Undo">
             <Undo className="w-4 h-4" />
           </Button>
        </div>

        {/* Right Actions */}
        <div className="flex gap-2">
          {!file && (
            <label className="cursor-pointer">
               <Button variant="outline" size="sm" asChild className="pointer-events-none">
                 <span>
                    <Upload className="w-4 h-4 mr-2" />
                    <span className="hidden sm:inline">Upload</span>
                 </span>
               </Button>
               <input type="file" accept="application/pdf" className="hidden" onChange={onFileChange} />
            </label>
          )}
          {file && (
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Save className="w-4 h-4 mr-2" />}
              <span className="hidden sm:inline">Download</span>
            </Button>
          )}
        </div>
      </header>

      {/* 2. Main Canvas */}
      <main className="flex-1 overflow-auto p-4 md:p-8 flex justify-center bg-slate-50 relative" ref={containerRef}>
        {!file ? (
          <div className="flex flex-col items-center justify-center text-slate-400 mt-20 animate-in fade-in zoom-in duration-300">
            <div className="w-24 h-24 bg-white rounded-full shadow-lg flex items-center justify-center mb-6">
              <Upload className="w-10 h-10 text-slate-300" />
            </div>
            <h3 className="text-xl font-semibold text-slate-700">Upload a PDF</h3>
            <p className="max-w-sm text-center mt-2">Upload a document to start editing, signing, or annotating securely.</p>
            <label className="mt-6">
               <Button size="lg" className="cursor-pointer" asChild>
                 <span>Select File</span>
               </Button>
               <input type="file" accept="application/pdf" className="hidden" onChange={onFileChange} />
            </label>
          </div>
        ) : (
          <div className="relative shadow-xl ring-1 ring-slate-900/5 my-auto">
             <Document
                file={file}
                onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                loading={<div className="p-10 text-slate-500"><Loader2 className="w-8 h-8 animate-spin" /></div>}
                className="flex flex-col gap-4"
              >
                {Array.from(new Array(numPages), (_, index) => (
                  <div 
                    key={`page_${index + 1}`} 
                    className="relative group bg-white transition-shadow hover:shadow-lg"
                    onClick={(e) => handlePageClick(e, index)}
                    style={{ cursor: tool === "none" ? "default" : "crosshair" }}
                  >
                    <Page 
                      pageNumber={index + 1} 
                      scale={scale} 
                      // If container is smaller than scaled PDF, let it scroll. 
                      // If container is larger, we center it.
                      // Responsive fix: If scale is 1.0 but screen is tiny, reduce scale?
                      // Better: Let user control scale, but init at a fit width.
                      renderTextLayer={false} 
                      renderAnnotationLayer={false}
                      className="max-w-full"
                    />
                    
                    {/* Render Annotations */}
                    {annotations
                      .filter(a => a.page === index + 1)
                      .map((ann) => (
                        <React.Fragment key={ann.id}>
                          {ann.type === "text" && (
                            <div
                              className="absolute text-black font-sans pointer-events-none select-none whitespace-pre"
                              style={{
                                left: ann.x * scale,
                                top: ann.y * scale,
                                transform: "translateY(-100%)",
                                fontSize: `${12 * scale}px`,
                                lineHeight: 1
                              }}
                            >
                              {ann.text}
                            </div>
                          )}
                          {ann.type === "rect" && (
                            <div
                              className="absolute border-2 border-yellow-500 bg-yellow-300/40"
                              style={{
                                left: ann.x * scale,
                                top: ann.y * scale,
                                width: (ann.width || 0) * scale,
                                height: (ann.height || 0) * scale,
                              }}
                            />
                          )}
                        </React.Fragment>
                      ))}
                  </div>
                ))}
              </Document>
          </div>
        )}
      </main>

      {/* 3. Text Input Dialog */}
      {isInputOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <Card className="w-full max-w-sm p-4 space-y-4 animate-in zoom-in-95 duration-200">
                <h3 className="font-semibold">Add Text</h3>
                <Input 
                    autoFocus 
                    placeholder="Enter text..." 
                    value={textInputValue}
                    onChange={(e) => setTextInputValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleTextSubmit()}
                />
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setIsInputOpen(false)}>Cancel</Button>
                    <Button onClick={handleTextSubmit}>Add</Button>
                </div>
            </Card>
        </div>
      )}
    </div>
  );
}

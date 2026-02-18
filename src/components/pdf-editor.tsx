import React, { useState, useRef } from "react";
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
import { modifyPdf, type PdfAnnotation } from "@/lib/pdf-utils";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// Determine API URL based on environment
const API_BASE = import.meta.env.PROD ? "/api" : "http://localhost:8787/api";

export function PdfEditor() {
  const [file, setFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  
  // View State
  const [scale, setScale] = useState(1.0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Tools State
  const [tool, setTool] = useState<"none" | "text" | "rect">("none");
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  
  // Text Input State
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [tempTextData, setTempTextData] = useState<{x: number, y: number, page: number} | null>(null);
  const [textInputValue, setTextInputValue] = useState("");

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
        await fetch(`${API_BASE}/session/upload`, {
          method: "POST",
          body: formData,
        });
        // Session ID returned here if needed in future: const data = await res.json();
      } catch (err) {
        console.error("Upload failed", err);
      }
    }
  };

  // 2. Handle Clicks on PDF Page
  const handlePageClick = (e: React.MouseEvent, pageIndex: number) => {
    if (tool === "none") return;

    const rect = e.currentTarget.getBoundingClientRect();
    
    // 1. Calculate the click position relative to the element (CSS pixels)
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // 2. Adjust for the current scale of the viewer
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

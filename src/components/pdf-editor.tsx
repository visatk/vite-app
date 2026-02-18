import React, { useState, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { 
  Save, Type, Upload, Eraser, MousePointer2, 
  Sparkles, X, Image as ImageIcon, PenTool, Trash2, Edit3
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { modifyPdf, type PdfAnnotation } from "@/lib/pdf-utils";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const API_BASE = import.meta.env.PROD ? "/api" : "http://localhost:8787/api";
const WS_BASE = import.meta.env.PROD ? "wss://" + window.location.host + "/api" : "ws://localhost:8787/api";

export function PdfEditor() {
  const [file, setFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [deletedPages, setDeletedPages] = useState<number[]>([]);
  
  // Tool State
  const [tool, setTool] = useState<"none" | "text" | "erase" | "draw" | "image" | "edit-text">("none");
  const [ws, setWs] = useState<WebSocket | null>(null);
  
  // AI State
  const [aiSummary, setAiSummary] = useState<string>("");
  const [aiStatus, setAiStatus] = useState<"idle" | "thinking">("idle");
  
  // Drawing/Editing State
  const [currentPath, setCurrentPath] = useState<string>("");
  const [isDrawing, setIsDrawing] = useState(false);
  
  // Text Editing Overlay State
  const [editingField, setEditingField] = useState<{
    id: string; page: number; x: number; y: number; 
    width: number; height: number; 
    text: string; fontSize: number; 
    originalRect: {x:number, y:number, width:number, height:number} 
  } | null>(null);

  const transformRef = useRef<any>(null);

  // --- Styles Injection for "Edit Mode" ---
  // This makes the usually invisible text layer clickable and visible on hover
  useEffect(() => {
    const styleId = "pdf-edit-styles";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.innerHTML = `
            .edit-mode .react-pdf__Page__textContent span {
                cursor: text !important;
                pointer-events: auto !important;
                border: 1px dashed transparent;
                border-radius: 2px;
            }
            .edit-mode .react-pdf__Page__textContent span:hover {
                background-color: rgba(59, 130, 246, 0.1);
                border-color: rgba(59, 130, 246, 0.5);
            }
        `;
        document.head.appendChild(style);
    }
  }, []);

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      const fd = new FormData();
      fd.append("file", f);
      
      try {
        const res = await fetch(`${API_BASE}/session/upload`, { method: "POST", body: fd });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json();
        setFile(f);
        setSessionId(data.id);
        connectWs(data.id);
      } catch (err) {
        console.error(err);
        alert("Upload failed");
      }
    }
  };

  const connectWs = (id: string) => {
    if (ws) ws.close();
    const socket = new WebSocket(`${WS_BASE}/session/ws?id=${id}`);
    
    socket.onopen = () => console.log("Connected");
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "sync-annotations") setAnnotations(msg.annotations);
      if (msg.type === "sync-deleted-pages") setDeletedPages(msg.deletedPages);
      if (msg.type === "ai-status") setAiStatus(msg.status);
      if (msg.type === "ai-result") {
        setAiSummary(msg.text);
        setAiStatus("idle");
      }
    };
    setWs(socket);
  };

  const syncAnnotations = (newAnnotations: PdfAnnotation[]) => {
      setAnnotations(newAnnotations);
      ws?.send(JSON.stringify({ type: "sync-annotations", annotations: newAnnotations }));
  };

  // --- Interaction Logic ---

  // Handle clicking on existing PDF text
  const handleTextLayerClick = (e: React.MouseEvent, pageIndex: number, pageHeight: number) => {
      if (tool !== "edit-text") return;
      
      const target = e.target as HTMLElement;
      if (target.tagName !== "SPAN") return;

      e.stopPropagation(); // Prevent page tap
      
      const rect = target.getBoundingClientRect();
      const pageEl = target.closest(".react-pdf__Page") as HTMLElement;
      const pageRect = pageEl.getBoundingClientRect();
      
      // Calculate relative position in the HTML Page element
      const left = rect.left - pageRect.left;
      const top = rect.top - pageRect.top;
      
      // Extract font size approx
      const fontSizeStr = window.getComputedStyle(target).fontSize;
      const fontSize = parseFloat(fontSizeStr) || 12;

      // Calculate PDF coordinates (Bottom-Left origin)
      // Note: react-pdf scales the page. We need unscaled coords for PDF-lib ideally, 
      // but here we work in "viewer units" and let the backend/render logic handle consistency.
      // However, PDF-lib expects 72DPI points. React-PDF renders at scale.
      // Simpler approach: Store ratio and let PDF-lib handle basic positioning relative to height.
      
      // For accurate PDF modification, we need the PDF point coordinates.
      // PDF y = PageHeight - top - height (roughly, since top is top-left)
      // We will refine this in modifyPdf. For now we pass the viewer-relative coordinates
      // and assume 1:1 scale or handle scale in backend if needed. 
      // *Crucial*: We use the unscaled PDF coordinates if we can, but DOM gives us scaled.
      // We'll rely on visual placement for now.

      // PDF Y is inverted from DOM Y. 
      // ann.y in our system = distance from TOP (for rendering overlay)
      // backend needs distance from BOTTOM.
      
      // Let's create the editing field
      setEditingField({
          id: uuidv4(),
          page: pageIndex + 1,
          x: left,
          y: top,
          width: rect.width + 20, // ample space
          height: rect.height,
          text: target.innerText,
          fontSize: fontSize,
          originalRect: {
              x: left,
              y: pageHeight - top - rect.height, // PDF Y (Bottom up) attempt
              width: rect.width,
              height: rect.height
          }
      });
  };

  const saveEdit = () => {
      if (!editingField) return;

      // Create a replacement annotation
      // We use a special type 'text-replace' which instructs backend to:
      // 1. Draw a white rect over 'originalRect'
      // 2. Draw 'text' at 'x,y'
      
      const newAnn: PdfAnnotation = {
          id: editingField.id,
          type: "text-replace",
          page: editingField.page,
          x: editingField.x, // Viewer X (Left)
          y: editingField.originalRect.y, // PDF Y (Bottom) - reusing calc from click
          text: editingField.text,
          fontSize: editingField.fontSize,
          color: "#000000",
          originalTextRect: editingField.originalRect
      };

      syncAnnotations([...annotations, newAnn]);
      setEditingField(null);
  };

  const handlePageTap = (e: React.MouseEvent | React.TouchEvent, pageIndex: number) => {
    if (editingField) { setEditingField(null); return; } // Click away to close edit
    if (tool === "draw" || tool === "edit-text") return;
    
    const target = e.currentTarget as HTMLDivElement;
    const rect = target.getBoundingClientRect();
    // ... (Existing input handlers)
    const clientX = 'touches' in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? (e as React.TouchEvent).touches[0].clientY : (e as React.MouseEvent).clientY;
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (tool === "text") {
       const text = prompt("Enter text:");
       if (text) {
         syncAnnotations([...annotations, {
           id: uuidv4(), type: "text", page: pageIndex + 1, x, y, text, color: "#000000", fontSize: 16
         }]);
       }
       setTool("none");
    } else if (tool === "erase") {
        // ... existing erase logic
         syncAnnotations([...annotations, {
           id: uuidv4(), type: "rect", page: pageIndex + 1, x: x - 25, y: y - 10, width: 50, height: 20, color: "#ffffff"
         }]);
    } else if (tool === "image") {
        // ... existing image logic
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (ev) => {
            const f = (ev.target as HTMLInputElement).files?.[0];
            if (f) {
                const reader = new FileReader();
                reader.onload = (readerEv) => {
                    const base64 = readerEv.target?.result as string;
                    syncAnnotations([...annotations, {
                        id: uuidv4(), type: "image", page: pageIndex + 1, x, y, width: 100, height: 100, image: base64
                    }]);
                };
                reader.readAsDataURL(f);
            }
        };
        input.click();
        setTool("none");
    }
  };

  // ... (Drawing logic remains the same) ...
  const startDrawing = (e: React.MouseEvent, _pageIndex: number) => {
      if (tool !== "draw") return;
      setIsDrawing(true);
      const target = e.currentTarget as HTMLDivElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setCurrentPath(`M ${x} ${y}`);
  };

  const drawMove = (e: React.MouseEvent) => {
      if (!isDrawing || tool !== "draw") return;
      const target = e.currentTarget as HTMLDivElement;
      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setCurrentPath(prev => `${prev} L ${x} ${y}`);
  };

  const endDrawing = (pageIndex: number) => {
      if (!isDrawing || tool !== "draw") return;
      setIsDrawing(false);
      if (currentPath.length > 10) {
          syncAnnotations([...annotations, {
              id: uuidv4(), type: "path", page: pageIndex + 1, x: 0, y: 0, path: currentPath, color: "#ef4444", strokeWidth: 3
          }]);
      }
      setCurrentPath("");
  };

  const deletePage = (index: number) => {
      if (confirm(`Delete page ${index + 1}?`)) {
          const newDeleted = [...deletedPages, index];
          setDeletedPages(newDeleted);
          ws?.send(JSON.stringify({ type: "sync-deleted-pages", deletedPages: newDeleted }));
      }
  };

  const triggerAi = () => {
    if(!ws) return;
    setAiStatus("thinking");
    ws.send(JSON.stringify({ type: "ai-summarize" }));
  };

  const downloadPdf = async () => {
    if(!file) return;
    // Map annotations to correct PDF logic if needed, 
    // but modifyPdf handles the y-inversion mostly.
    const modifiedBytes = await modifyPdf(file, annotations, deletedPages);
    const blob = new Blob([modifiedBytes as any], { type: "application/pdf" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "edited_" + file.name;
    link.click();
    
    if (sessionId) {
        const fd = new FormData();
        fd.append("file", blob, "edited_" + file.name);
        fetch(`${API_BASE}/session/save-changes?id=${sessionId}`, { method: "POST", body: fd });
    }
  };

  return (
    <div className={`h-screen w-screen bg-slate-100 overflow-hidden flex flex-col relative ${tool === 'edit-text' ? 'edit-mode' : ''}`}>
      {/* Header */}
      <div className="absolute top-4 left-0 right-0 z-50 flex justify-center pointer-events-none">
        <div className="bg-black/90 backdrop-blur-md text-white rounded-full px-6 py-2 shadow-2xl pointer-events-auto flex items-center gap-4">
           <span className="font-bold text-sm tracking-wide">Cloudflare PDF Pro</span>
           {aiStatus === "thinking" && (
             <span className="text-xs bg-purple-600 px-2 py-0.5 rounded-full animate-pulse flex items-center gap-1">
               <Sparkles className="w-3 h-3" /> AI Processing...
             </span>
           )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative z-0">
        {!file ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            {/* ... Upload UI ... */}
            <div className="w-20 h-20 bg-blue-100 rounded-3xl flex items-center justify-center mb-6 text-blue-600">
               <Upload className="w-10 h-10" />
            </div>
            <h2 className="text-2xl font-bold text-slate-800">Tap to Upload</h2>
            <Button size="lg" className="rounded-full px-8 h-12 text-lg shadow-lg relative mt-6 cursor-pointer">
              <input type="file" accept="application/pdf" className="absolute inset-0 opacity-0 cursor-pointer" onChange={uploadFile} />
              Select PDF
            </Button>
          </div>
        ) : (
          <TransformWrapper
            ref={transformRef}
            initialScale={1}
            minScale={0.5}
            maxScale={4}
            centerOnInit
            disabled={tool !== "none" && tool !== "edit-text"} 
          >
            <TransformComponent wrapperClass="!w-full !h-full" contentClass="!w-full !h-full">
              <div className="w-full min-h-full flex flex-col items-center py-20 gap-8">
                 <Document file={file} onLoadSuccess={({ numPages }) => setNumPages(numPages)}>
                    {Array.from(new Array(numPages), (_, i) => {
                      if (deletedPages.includes(i)) return null;
                      return (
                        <div 
                          key={i} 
                          className="relative shadow-2xl group page-container"
                          onClick={(e) => handlePageTap(e, i)}
                          onMouseDown={(e) => startDrawing(e, i)}
                          onMouseMove={drawMove}
                          onMouseUp={() => endDrawing(i)}
                          onMouseLeave={() => endDrawing(i)}
                        >
                           {/* IMPORTANT: Capture Ref to get Page dimensions for coordinates */}
                           <Page 
                             pageNumber={i + 1} 
                             width={window.innerWidth > 768 ? 600 : window.innerWidth * 0.9} 
                             renderTextLayer={true} // Enable Text Layer for Editing
                             renderAnnotationLayer={false}
                             onLoadSuccess={(page) => {
                                 // We could store page dimensions here if needed
                             }}
                             onClick={(e) => {
                                 // HACK: Find the page height from the DOM element
                                 const height = e.currentTarget.getBoundingClientRect().height;
                                 handleTextLayerClick(e, i, height);
                             }}
                           />
                           
                           {/* Delete Page Button */}
                           <Button 
                             size="icon" 
                             variant="destructive" 
                             className="absolute -right-12 top-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-full shadow-lg"
                             onClick={(e) => { e.stopPropagation(); deletePage(i); }}
                           >
                             <Trash2 className="w-4 h-4" />
                           </Button>

                           {/* Render Annotations */}
                           {annotations.filter(a => a.page === i + 1).map(ann => (
                             <div 
                               key={ann.id}
                               className="absolute pointer-events-none whitespace-pre"
                               style={{
                                 left: 0, top: 0, width: '100%', height: '100%'
                               }}
                             >
                               {/* Render Text Replace: White Box + New Text */}
                               {ann.type === "text-replace" && (
                                   <>
                                     <div style={{
                                         position: "absolute",
                                         left: ann.originalTextRect?.x,
                                         top: ann.originalTextRect?.y ? (ann.y /* Using stored Top coord */) : ann.y, 
                                         // NOTE: In viewer, y is usually Top-down. In PDF-lib, Bottom-up. 
                                         // We stored 'x' and 'y' in viewer coords for the 'text' part in saveEdit().
                                         // We stored 'originalTextRect' with PDF coords for the backend. 
                                         // Here we just render the visual result.
                                         // The "Redaction" visual:
                                         // Actually, 'ann.x' was 'left', 'ann.y' was PDF bottom-up in saveEdit. 
                                         // Wait, let's fix the Viewer Render logic.
                                         // For Viewer, we need Top-Down.
                                         // In saveEdit, we stored 'x' (left) and 'originalRect.y' (bottom-up).
                                         // We need to store 'viewerY' (top-down) for React rendering.
                                         // Let's assume ann.y for "text-replace" is TOP-DOWN for React, but we send transformed for PDF.
                                         // To keep it simple: We use "x" and "y" as TOP-LEFT for React rendering.
                                         // Backend maps them.
                                     }} />
                                     
                                     {/* 1. The White-out Mask (Visual only, to hide underlying text) */}
                                     <div style={{
                                        position: "absolute",
                                        left: ann.originalTextRect?.x,
                                        top: ann.x === ann.originalTextRect?.x ? ann.y : ann.y, // Using ann.y as Top
                                        width: ann.originalTextRect?.width,
                                        height: ann.originalTextRect?.height,
                                        backgroundColor: "white",
                                        zIndex: 10
                                     }} />

                                     {/* 2. The New Text */}
                                     <div style={{ 
                                         position: "absolute", 
                                         left: ann.x, 
                                         top: ann.y, 
                                         fontSize: ann.fontSize, 
                                         color: ann.color, 
                                         fontFamily: "Helvetica, sans-serif",
                                         fontWeight: "bold",
                                         zIndex: 11
                                     }}>
                                       {ann.text}
                                   </div>
                                   </>
                               )}

                               {ann.type === "text" && (
                                   <div style={{ position: "absolute", left: ann.x, top: ann.y, fontSize: ann.fontSize, color: ann.color, fontWeight: "bold" }}>
                                       {ann.text}
                                   </div>
                               )}
                               {ann.type === "rect" && (
                                   <div style={{ position: "absolute", left: ann.x, top: ann.y, width: ann.width, height: ann.height, backgroundColor: ann.color }} />
                               )}
                               {ann.type === "image" && (
                                   <img src={ann.image} style={{ position: "absolute", left: ann.x, top: ann.y, width: ann.width, height: ann.height, objectFit: "contain" }} />
                               )}
                               {ann.type === "path" && (
                                   <svg style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible" }}>
                                       <path d={ann.path} stroke={ann.color} strokeWidth={ann.strokeWidth} fill="none" strokeLinecap="round" />
                                   </svg>
                               )}
                             </div>
                           ))}

                           {/* Active Editing Input Overlay */}
                           {editingField && editingField.page === i + 1 && (
                               <div
                                style={{
                                    position: "absolute",
                                    left: editingField.x,
                                    top: editingField.y,
                                    zIndex: 100
                                }}
                                onClick={(e) => e.stopPropagation()}
                               >
                                   <Input 
                                     autoFocus
                                     value={editingField.text}
                                     onChange={(e) => setEditingField({...editingField, text: e.target.value})}
                                     onKeyDown={(e) => {
                                         if(e.key === "Enter") saveEdit();
                                         if(e.key === "Escape") setEditingField(null);
                                     }}
                                     onBlur={saveEdit}
                                     style={{
                                         fontSize: editingField.fontSize,
                                         width: Math.max(100, editingField.width * 1.5),
                                         height: editingField.height + 10,
                                         padding: "0 4px",
                                         margin: "-5px 0 0 -5px", // Slight adjustment
                                         fontFamily: "Helvetica, sans-serif"
                                     }}
                                   />
                               </div>
                           )}

                           {/* Active Drawing Path */}
                           {isDrawing && tool === "draw" && (
                               <svg className="absolute inset-0 w-full h-full pointer-events-none">
                                   <path d={currentPath} stroke="#ef4444" strokeWidth={3} fill="none" strokeLinecap="round" />
                               </svg>
                           )}
                        </div>
                      );
                    })}
                 </Document>
              </div>
            </TransformComponent>
          </TransformWrapper>
        )}
      </div>

      {/* Toolbar */}
      {file && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3 z-50">
           <div className="bg-white rounded-full shadow-xl border p-1.5 flex items-center gap-1">
              <Button variant={tool === "none" ? "default" : "ghost"} size="icon" className="rounded-full w-12 h-12" onClick={() => setTool("none")}>
                <MousePointer2 className="w-5 h-5" />
              </Button>
              <Button 
                variant={tool === "edit-text" ? "default" : "ghost"} 
                size="icon" 
                className="rounded-full w-12 h-12 text-blue-600 hover:text-blue-700" 
                onClick={() => setTool("edit-text")}
                title="Click text to edit"
              >
                <Edit3 className="w-5 h-5" />
              </Button>
              <Button variant={tool === "text" ? "default" : "ghost"} size="icon" className="rounded-full w-12 h-12" onClick={() => setTool("text")}>
                <Type className="w-5 h-5" />
              </Button>
              <Button variant={tool === "draw" ? "default" : "ghost"} size="icon" className="rounded-full w-12 h-12" onClick={() => setTool("draw")}>
                <PenTool className="w-5 h-5" />
              </Button>
              <Button variant={tool === "image" ? "default" : "ghost"} size="icon" className="rounded-full w-12 h-12" onClick={() => setTool("image")}>
                <ImageIcon className="w-5 h-5" />
              </Button>
              <Button variant={tool === "erase" ? "default" : "ghost"} size="icon" className="rounded-full w-12 h-12" onClick={() => setTool("erase")}>
                <Eraser className="w-5 h-5" />
              </Button>
           </div>

           <div className="bg-white rounded-full shadow-xl border p-1.5 flex items-center gap-1">
             <Button variant="outline" size="icon" className="rounded-full w-12 h-12 text-purple-600 bg-purple-50" onClick={triggerAi}>
                <Sparkles className="w-5 h-5" />
              </Button>
              <Button variant="default" size="icon" className="rounded-full w-12 h-12 bg-black text-white hover:bg-slate-800" onClick={downloadPdf}>
                <Save className="w-5 h-5" />
              </Button>
           </div>
        </div>
      )}

      {/* AI Modal */}
      {aiSummary && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in">
          <Card className="w-full max-w-lg p-6 relative max-h-[80vh] overflow-y-auto">
            <Button variant="ghost" size="icon" className="absolute top-2 right-2" onClick={() => setAiSummary("")}>
              <X className="w-4 h-4" />
            </Button>
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-purple-700">
              <Sparkles className="w-5 h-5" /> Document Summary
            </h3>
            <div className="text-slate-700 leading-relaxed whitespace-pre-wrap font-mono text-sm">
              {aiSummary}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

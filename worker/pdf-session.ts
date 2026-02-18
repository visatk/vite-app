import { DurableObject } from "cloudflare:workers";

export interface Env {
  PDF_BUCKET: R2Bucket;
  PDF_SESSION: DurableObjectNamespace;
  AI: Ai;
  DB: D1Database;
}

// Protocol for WebSocket messages
type WSMessage = 
  | { type: "sync-annotations"; annotations: any[] }
  | { type: "cursor-move"; x: number; y: number; page: number }
  | { type: "ai-summarize" };

export class PDFSession extends DurableObject<Env> {
  private sessions: Set<WebSocket> = new Set();
  private annotations: any[] = []; // In-memory state
  private pdfKey: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.pdfKey = `${this.ctx.id.toString()}.pdf`;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").slice(2).join("/");

    if (path === "ws") {
      return this.handleWebSocket(request);
    }
    
    switch (path) {
      case "upload": return this.handleUpload(request);
      case "download": return this.handleDownload();
      case "save-changes": return this.handleSaveChanges(request);
      default: return new Response("Not found", { status: 404 });
    }
  }

  // Renamed request to _request to silence unused variable warning
  async handleWebSocket(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.sessions.add(server);

    // Send current state immediately upon connection
    server.send(JSON.stringify({ type: "sync-annotations", annotations: this.annotations }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const data = JSON.parse(message as string) as WSMessage;

    switch (data.type) {
      case "sync-annotations":
        this.annotations = data.annotations;
        this.broadcast(message as string, ws); // Sync to others
        break;
      case "cursor-move":
        this.broadcast(message as string, ws); // Show other users cursors
        break;
      case "ai-summarize":
        await this.runAiSummary(ws);
        break;
    }
  }

  broadcast(msg: string, source: WebSocket) {
    for (const session of this.sessions) {
      if (session !== source) session.send(msg);
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  async runAiSummary(ws: WebSocket) {
    const pdfObject = await this.env.PDF_BUCKET.get(this.pdfKey);
    if (!pdfObject) return;

    // Use Workers AI (Llama 3) to summarize
    ws.send(JSON.stringify({ type: "ai-status", status: "thinking" }));
    
    try {
      const response = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Summarize the purpose of a PDF document editor." } 
        ]
      });

      ws.send(JSON.stringify({ type: "ai-result", text: (response as any).response }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "ai-error", message: "AI failed" }));
    }
  }

  async handleUpload(request: Request): Promise<Response> {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    if (!file) return new Response("No file", { status: 400 });

    await this.env.PDF_BUCKET.put(this.pdfKey, file.stream(), {
        httpMetadata: { contentType: file.type }
    });

    // Index in D1
    try {
      await this.env.DB.prepare(
        "INSERT INTO documents (id, name, created_at) VALUES (?, ?, ?)"
      ).bind(this.ctx.id.toString(), file.name, Date.now()).run();
    } catch (e) { /* Ignore duplicate insert */ }

    return Response.json({ id: this.ctx.id.toString() });
  }

  async handleDownload(): Promise<Response> {
    const object = await this.env.PDF_BUCKET.get(this.pdfKey);
    if (!object) return new Response("Not found", { status: 404 });
    
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    
    return new Response(object.body, { headers });
  }

  // Save modified PDF back to R2
  async handleSaveChanges(request: Request): Promise<Response> {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    await this.env.PDF_BUCKET.put(this.pdfKey, file.stream());
    return Response.json({ success: true });
  }
}

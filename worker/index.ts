import { PDFSession } from "./pdf-session";

export { PDFSession };

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS Preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Upgrade, WebSocket",
				},
			});
		}

		// Route to Durable Object
		if (url.pathname.startsWith("/api/session")) {
			const idParam = url.searchParams.get("id");
			// If no ID provided, generate a new random ID for the DO
			const id = idParam
				? env.PDF_SESSION.idFromString(idParam)
				: env.PDF_SESSION.newUniqueId();
			
			const stub = env.PDF_SESSION.get(id);

			const response = await stub.fetch(request);
			
			// Re-attach CORS headers to the response from DO
			const newHeaders = new Headers(response.headers);
			newHeaders.set("Access-Control-Allow-Origin", "*");
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
			});
		}

		return new Response("Cloudflare PDF Core Ready", { status: 200 });
	},
} satisfies ExportedHandler<Env>;

// vision-proxy.ts: let a text-only model "see" images by having a vision model describe them.
//
// Why (2026-10-11): halo-prep's :8092 moved from Cyber-Tiel-Coder-35B-A3B (with a vision
// projector) to Mellum2.1-12B-A2.5B, which is text only. pi does not error or switch models when
// a text-only model meets an image: it silently replaces it with "(image omitted: model does not
// support images)" (pi-ai transform-messages.js), and `read` adds "[Current model does not
// support images…]". So a photo sent on Signal or pasted into pi-web would vanish without a word.
//
// What: when the CURRENT model's models.json `input` lacks "image", every image is sent to the
// vision model (default Ornith-1.5-35B-A3B on :8088, which already loads its projector) and
// replaced by its description, as text, before pi persists anything:
//   - `input`: images the user attached (interactive pi, pi-web) are described together with the
//     user's own text, so the description answers the question rather than describing blindly.
//   - `tool_result`: image blocks a tool returned. This is how Signal images arrive: pi-signal
//     saves the attachment and the model `read`s the path. Camofox screenshots land here too.
//   - a `look` tool for follow-up questions about an image file the description did not cover.
// A model that does take images (GLM, a vision model on /model) is left alone.
//
// Why describe rather than switch models per message: a model switch throws away the prompt
// cache on both sides, and :8088 is ONE slot shared with Open Notebook, so moving a whole
// conversation there would re-read up to 131K tokens into it and hold it for the whole tool
// loop. A description is one short request, and the session keeps its model and its cache.
// The cost: detail the description leaves out is gone, which is what `look` is for.
//
// Failure is explicit, never silent: if the vision model is down or busy past the timeout, the
// image is replaced with a note saying it could not be described and why.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const URL = process.env.PI_VISION_URL ?? "http://127.0.0.1:8088/v1/chat/completions";
const MODEL = process.env.PI_VISION_MODEL ?? "ornith-1.5-35b-a3b";
// :8088 is single-slot; an Open Notebook prefill can hold it for a minute or more.
const TIMEOUT_MS = Number(process.env.PI_VISION_TIMEOUT_MS ?? 120000);
const LABEL = process.env.PI_VISION_LABEL ?? "Ornith-35B on :8088";
const MIME: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

type Img = { type: "image"; data: string; mimeType: string };

const BRIEF =
	"You are the eyes of an assistant that cannot see images. Describe the image(s) so that it can " +
	"answer without them: what is shown, layout, and ALL visible text transcribed exactly (numbers, " +
	"names, code, error messages, table cells). Say plainly if something is unreadable; do not guess. " +
	"No preamble.";

function textOnly(ctx: any): boolean {
	const input = ctx?.model?.input;
	return Array.isArray(input) && !input.includes("image");
}

async function describe(images: Img[], question: string): Promise<string> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const r = await fetch(URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: ac.signal,
			body: JSON.stringify({
				model: MODEL,
				temperature: 0.2,
				max_tokens: 2048,
				chat_template_kwargs: { enable_thinking: false },
				messages: [
					{ role: "system", content: BRIEF },
					{
						role: "user",
						content: [
							{ type: "text", text: question ? `The user's message, for context: ${question}` : "Describe the image(s)." },
							...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
						],
					},
				],
			}),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j: any = await r.json();
		const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
		if (!text) throw new Error("empty description");
		return text;
	} catch (e: any) {
		throw new Error(e?.name === "AbortError" ? `no answer within ${TIMEOUT_MS / 1000} s (busy?)` : String(e?.message ?? e));
	} finally {
		clearTimeout(timer);
	}
}

async function asText(images: Img[], question: string): Promise<string> {
	const n = images.length === 1 ? "Image" : `${images.length} images`;
	try {
		return `[${n} described by ${LABEL}; you cannot see it directly. Use the look tool on the file for follow-up questions.]\n${await describe(images, question)}`;
	} catch (e: any) {
		return `[${n} could not be described (${LABEL}: ${e.message}). Tell the user you could not see it.]`;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (!event.images?.length || !textOnly(ctx)) return { action: "continue" as const };
		const note = await asText(event.images as Img[], event.text);
		return { action: "transform" as const, text: `${event.text}\n\n${note}`, images: [] };
	});

	pi.on("tool_result", async (event: any, ctx) => {
		const images = (event.content ?? []).filter((c: any) => c.type === "image") as Img[];
		if (!images.length || !textOnly(ctx)) return undefined;
		const path = typeof event.input?.path === "string" ? `the file ${event.input.path}` : `a ${event.toolName} result`;
		const note = await asText(images, `The assistant opened ${path}.`);
		// pi's own "[Current model does not support images…]" line would contradict the note.
		const rest = (event.content as any[])
			.filter((c) => c.type === "text")
			.map((c) => ({ ...c, text: String(c.text).replace(/\n?\[Current model does not support images[^\]]*\]/, "") }))
			.filter((c) => c.text.trim());
		return { content: [...rest, { type: "text" as const, text: note }] };
	});

	pi.registerTool(
		defineTool({
			name: "look",
			label: "Look",
			description:
				`Ask a vision model (${LABEL}) a question about an image file (png, jpg, gif, webp, bmp). ` +
				"Use it when you need detail from an image that an earlier description did not give.",
			parameters: Type.Object({
				path: Type.String({ description: "Path to the image file." }),
				question: Type.String({ description: "What you need to know about the image." }),
			}),
			async execute(_id, p) {
				const mimeType = MIME[extname(p.path).toLowerCase()];
				if (!mimeType) throw new Error(`not an image type look understands: ${p.path}`);
				const data = readFileSync(p.path).toString("base64");
				const text = await describe([{ type: "image", data, mimeType }], p.question);
				return { content: [{ type: "text" as const, text }], details: {} };
			},
		}),
	);
}

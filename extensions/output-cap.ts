// output-cap.ts: cap large tool output as it arrives (halo-prep docs/16, step 2).
//
// Why: tool results are 38-92% of the context in this box's real sessions, and every token of
// them is prefilled at ~700 tok/s by 64K depth on :8092. Stock pi lets one call return up to
// 2,000 lines / 50 KB (~12K tokens; dist/core/tools/truncate.js, not configurable), and a
// Signal chat reached 66K tokens in 8 messages from 81 bash calls.
//
// What: on `tool_result`, if the text is over PI_OUTPUT_CAP_CHARS (default 12000), keep the head
// and the (larger) tail, save the full text to a file, and tell the model where it is and how
// to read more. Only the NEW result is changed, before pi persists it, so the prompt cache is
// never touched (halo-prep docs/16: appending is free, editing history is not). No model calls.
//
// `read` is capped differently (added 2026-09-26, operator's call). pi pages it by lines
// (2,000 lines / 50 KB), but a model asking for 140 lines of a converted PDF still got 32.6K
// characters of long paragraphs in one result. Over PI_OUTPUT_CAP_READ_CHARS (default 20000):
// keep the HEAD only, cut at a line boundary, since reading continues forward. pi's own
// "[Showing lines … Use offset=N]" notice is replaced with one giving the exact offset to
// continue from. No spill file: the file itself is the full copy.
//
// Not capped:
//   - `browser`: Camofox snapshots carry element refs the next click needs. A cut in the
//     middle would break the page model.
//   - Images pass through untouched.
// For bash, pi has usually spilled the full output already (details.fullOutputPath). That file
// is reused, so no second copy is written.
//
// Checked before writing this (2026-09-26, halo-prep docs/16 "Existing packages checked"): nothing on npm
// did only this. The popular ones rewrite the model's shell commands through a third-party
// wrapper, and @spences10/pi-context also caps `read` and keeps output where only its own tools
// can reach it.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAP = Number(process.env.PI_OUTPUT_CAP_CHARS ?? 12000); // 0 disables
const HEAD = Math.round(CAP * 0.3); // errors and summaries usually sit at the end
const TAIL = CAP - HEAD;
const READ_CAP = Number(process.env.PI_OUTPUT_CAP_READ_CHARS ?? 20000); // 0 disables
const SKIP = new Set(["browser"]);
// pi's read.js appends one of these; it is dropped and replaced when the result is capped.
const PI_READ_NOTICE = /\n\n\[(?:Showing lines [^\]]*|\d+ more lines in file\.[^\]]*)\]\s*$/;

function capRead(text: string, input: any): string | undefined {
	if (!(READ_CAP > 0) || text.length <= READ_CAP) return undefined;
	const body = text.replace(PI_READ_NOTICE, "");
	if (body.length <= READ_CAP) return undefined;
	const start = Number.isFinite(input?.offset) && input.offset > 0 ? Math.floor(input.offset) : 1;
	const cut = body.lastIndexOf("\n", READ_CAP);
	if (cut <= 0) {
		// One line longer than the cap: nothing line-shaped to hand back.
		return (
			`${body.slice(0, READ_CAP)}\n\n[output-cap: line ${start} alone is over ${READ_CAP} characters ` +
			`(${body.length} in this result). Read it in pieces with bash, e.g. sed -n '${start}p' <file> | cut -c1-${READ_CAP}.]`
		);
	}
	const kept = body.slice(0, cut);
	const lines = kept.split("\n").length;
	const next = start + lines;
	return (
		`${kept}\n\n[output-cap: showing lines ${start}-${next - 1} (${kept.length} of ${body.length} characters in this result). ` +
		`Use offset=${next} to continue, with a smaller limit if the lines are long.]`
	);
}
const DIR = join(homedir(), ".local/state/pi-tool-output");
const KEEP_DAYS = 14;

function prune() {
	try {
		const cutoff = Date.now() - KEEP_DAYS * 86400_000;
		for (const d of readdirSync(DIR)) {
			const p = join(DIR, d);
			if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
		}
	} catch {
		// Nothing to prune yet.
	}
}

export default function outputCap(pi: ExtensionAPI) {
	if (!(CAP > 0)) return;

	pi.on("session_start", async () => prune());

	pi.on("tool_result", async (event) => {
		try {
			if (SKIP.has(event.toolName)) return undefined;
			const texts = event.content.filter((c: any) => c.type === "text") as { type: "text"; text: string }[];
			const full = texts.map((t) => t.text).join("\n");
			if (event.toolName === "read") {
				const capped = capRead(full, event.input);
				if (!capped) return undefined;
				const others = event.content.filter((c: any) => c.type !== "text");
				return { content: [{ type: "text", text: capped }, ...others] as any };
			}
			if (full.length <= CAP) return undefined;

			let path: string | undefined = (event as any).details?.fullOutputPath;
			if (!path || !existsSync(path)) {
				const day = new Date().toISOString().slice(0, 10);
				mkdirSync(join(DIR, day), { recursive: true, mode: 0o700 });
				path = join(DIR, day, `${event.toolName}-${event.toolCallId.replace(/[^\w-]/g, "_")}.txt`);
				writeFileSync(path, full, { mode: 0o600 });
			}
			const omitted = full.length - HEAD - TAIL;
			const lines = full.split("\n").length;
			const note =
				`[output-cap: showing the first ${HEAD} and last ${TAIL} of ${full.length} characters (${lines} lines); ` +
				`${omitted} characters omitted. Full output: ${path}. Use grep on that file, or read it with offset/limit, for the rest.]`;
			const capped = `${full.slice(0, HEAD)}\n\n[… ${omitted} characters omitted …]\n\n${full.slice(-TAIL)}\n\n${note}`;
			const others = event.content.filter((c: any) => c.type !== "text");
			return { content: [{ type: "text", text: capped }, ...others] as any };
		} catch {
			// Never break a tool result: on any error pass it through unchanged.
			return undefined;
		}
	});
}

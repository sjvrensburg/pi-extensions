// memory-guard.ts: keep personal data out of long-term memory (halo-prep docs/16, step 3).
//
// @pify/memory (installed as a pi package) writes whatever `memory_write` is given into
// ~/.pi/agent/memory/, shared by every pi surface. Its own gate catches secrets (token shapes,
// secret-valued env vars) but not personal data. Signal messages, and the documents pi-web
// reads, are full of other people's phone numbers, e-mail addresses, ID numbers and street
// addresses. None of that belongs in a file recalled into every future session.
//
// So this blocks a `memory_write` whose text looks like personal data, and tells the model to
// store the fact without the identifying detail ("the plumber's number is in the Signal chat
// of 2026-09-26" rather than the number itself). A block is a normal tool error the model
// can react to, and the entry is simply not written. It fails open: a crash in here lets the
// write through, because pify's own secret gate still applies.
//
// Patterns are deliberately narrow (South African formats first, since that is this box's
// traffic). False negatives are possible and false positives cost one rewritten memory entry.
// The nightly consolidation job (memory/memory-consolidate.py) runs the same checks.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHECKS: [string, RegExp][] = [
	["an e-mail address", /[\w.+-]+@[\w-]+\.[\w.-]{2,}/],
	// +27 82 123 4567, 082 123 4567, 0821234567, (021) 555-1234, +44 20 7946 0958
	["a phone number", /(?:\+\d{1,3}[\s-]?)?\(?0?\d{2,3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/],
	// South African ID: YYMMDD SSSS C A Z, 13 digits
	["an ID number", /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}\b/],
	["a bank card number", /\b(?:\d[ -]?){13,19}\b/],
	["an IBAN", /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/],
	["a street address", /\b\d{1,5}\s+(?:[A-Z][\w'-]*\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Crescent|Cres|Close|Way|Boulevard|Blvd|Place|Pl)\b/],
];

export function personalData(text: string): string | undefined {
	for (const [what, re] of CHECKS) if (re.test(text)) return what;
	return undefined;
}

export default function memoryGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		try {
			if (event.toolName !== "memory_write") return undefined;
			const text = String((event.input as any)?.text ?? "");
			const what = personalData(text);
			if (!what) return undefined;
			return {
				block: true,
				reason:
					`memory-guard: not saved, the entry contains what looks like ${what}. Long-term memory is ` +
					"shared by every pi surface and recalled into future sessions, so it must not hold personal " +
					"data. Save the fact without the identifying detail (say where the detail can be found instead), " +
					"or skip it.",
			};
		} catch {
			return undefined; // fail open; pify's secret gate still runs
		}
	});
}

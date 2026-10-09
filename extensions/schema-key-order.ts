import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Re-emit every tool's JSON schema with `properties` BEFORE `required`.
//
// Why this exists: TypeBox (which pi and every pi extension use to define tools)
// serialises `required` first. The Qwen-family chat templates this box serves
// render tools with `tojson`, so key order is literal prompt text -- and on
// Ornith-1.5-9B it decides whether an optional bound survives into the call.
// Measured 2026-09-24 (halo-prep docs/13 Phase 0), prompt "…only give me the top 3
// results", Hermes's real web_search schema, pi's system prompt + tools, thinking
// on, temp 0: `limit` kept 0/3 as pi sends it, 3/3 with this reorder. With
// thinking OFF it is 0/3 either way -- this fixes the key-order half only.
//
// Semantics are unchanged (JSON object key order carries no meaning); only the
// rendered prompt changes, so this is safe to leave on for every provider.
function reorder(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(reorder);
	if (!schema || typeof schema !== "object") return schema;
	const s = schema as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of ["type", "description", "properties"]) if (k in s) out[k] = s[k];
	for (const [k, v] of Object.entries(s)) if (!(k in out)) out[k] = v;
	if (out.properties && typeof out.properties === "object") {
		out.properties = Object.fromEntries(
			Object.entries(out.properties as Record<string, unknown>).map(([k, v]) => [k, reorder(v)]),
		);
	}
	if (out.items) out.items = reorder(out.items);
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as { tools?: Array<{ function?: { parameters?: unknown } }> };
		if (!Array.isArray(payload?.tools)) return;
		return {
			...payload,
			tools: payload.tools.map((t) =>
				t.function?.parameters ? { ...t, function: { ...t.function, parameters: reorder(t.function.parameters) } } : t,
			),
		};
	});
}

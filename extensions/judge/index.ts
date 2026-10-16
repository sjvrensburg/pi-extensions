// judge: mu-style routing on stock pi (halo-prep docs/15-pi-judge.md, phases 1-3).
//
// On every user message, one request to a typed-decision model (Winnow-E4B on :8098,
// POST /v1/systemone) asks mu's 10 preflight questions. The answers pick a "gear"
// (chat / light / standard / heavy), and the gear picks a thinking level and, for heavy
// work, a model. The decision model generates no text: each answer is a probability per
// option from one forward pass, ~0.6 s for all 10.
//
// ACTIVE BY DEFAULT, deliberately (operator, 2026-09-26): before this, Ornith ran every
// message ungated at medium thinking, and a wrong gear costs little next to that.
// PI_JUDGE_MODE=shadow records decisions without acting; =off skips the judge.
//
// FAIL OPEN. A timeout, an HTTP error, or an answer in the unsure band (0.2 < p < 0.8,
// choice p < 0.6) means the turn goes ahead as stock pi would have run it. A handler that
// throws would surface as an error on every message, so everything is caught here.
//
// EVERY DECISION IS LOGGED, IN FULL, FOR FINE-TUNING (operator, 2026-09-26). That means the
// state (the user's message and recent turns), the questions, the raw answers, the verdicts
// and the actions. Two sinks:
//   - ~/.local/share/pi-judge/decisions.jsonl (mode 600). One line per decision, plus
//     "override" lines when the user changes the model or thinking level the judge picked.
//     Overrides are the cheapest correction labels there will be.
//   - a `judge.decision` custom entry in the session. It never reaches the model and follows
//     branches, so a decision can be read next to the turn it shaped.
// The log holds message text from every pi surface (terminal, Signal, pi-web) in plain text.
//
// WHAT PINS A CHOICE. Routing never overrides an explicit human choice:
//   - `--model`/`--provider` on the command line pins the model. This covers Omnigent's pi
//     worker, whose spec names local-ornith on purpose. `--thinking` pins the thinking level.
//   - /model or /thinking (or any model/thinking change the judge did not make) pins that
//     setting for the rest of the session.
// pi-job runs with -ne (no extensions), so the timers never load this file.
//
// Wording and scenarios: mu's input.preflight v4 (github.com/qybaihe/mu, MIT), measured in
// judge-bench/preflight.py. Change a question there first; bump VERSION when a
// question, an option or the state layout changes, so the log can be split by version.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const VERSION = 2; // of the decision spec below (questions, options, state layout, policy)
const DECISION = "input.preflight";

type Mode = "off" | "shadow" | "active";
type Gear = "chat" | "light" | "standard" | "heavy";
type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const LEVELS: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ── configuration: ~/.pi/agent/judge.json, then environment ──────────────────────────────
type Config = {
	mode: Mode;
	url: string; // systemone base URL, or a chat-completions base URL when backend is "llm"
	backend: "systemone" | "llm";
	llmModel: string; // model name sent to the llm backend
	timeoutMs: number;
	maxSwitchTokens: number; // change thinking only below this context size (see switchCost)
	heavyModel: string; // provider/id; used only when its auth is configured
	thinking: Record<Gear, Level>;
	log: string;
};

function loadConfig(): Config {
	const base: Config = {
		mode: "active",
		url: "http://127.0.0.1:8098",
		backend: "systemone",
		llmModel: "caveowl-35b-a3b",
		// Winnow answers 10 questions in ~0.6 s idle; the margin is for a GPU busy with a
		// long Ornith prefill. Past this the message goes ahead unjudged.
		timeoutMs: 2500,
		// ~6-8 s of re-read on :8092 (1100-1450 tok/s at shallow depth). See switchCost.
		maxSwitchTokens: 8192,
		heavyModel: "zai/glm-5.3",
		// Ornith's models.json map supports only off and medium, so on Ornith light lands on
		// off and heavy on medium (see pickLevel). Thinking off on the 35B passed the pi tool
		// harness 9/9 at 2.9 s against 3.8 s on (halo-prep docs/13 Phase 0 results). :8092's
		// Gemma-4-E4B (2026-10-11) supports only off and high, so chat, light AND standard land on
		// off there: thinking cost it 8x the time on the tool harness (18.5 s vs 2.2 s) for no
		// accuracy gain (halo-prep config/llama-ornith.service, GEMMA SWAP).
		thinking: { chat: "off", light: "low", standard: "medium", heavy: "high" },
		log: join(homedir(), ".local/share/pi-judge/decisions.jsonl"),
	};
	try {
		const file = join(homedir(), ".pi/agent/judge.json");
		if (existsSync(file)) {
			const j = JSON.parse(readFileSync(file, "utf8"));
			Object.assign(base, j, { thinking: { ...base.thinking, ...(j.thinking ?? {}) } });
		}
	} catch {
		// A broken judge.json must not break pi; defaults apply.
	}
	const env = process.env;
	if (env.PI_JUDGE_MODE && ["off", "shadow", "active"].includes(env.PI_JUDGE_MODE)) base.mode = env.PI_JUDGE_MODE as Mode;
	if (env.PI_JUDGE_URL) base.url = env.PI_JUDGE_URL;
	if (env.PI_JUDGE_BACKEND === "llm" || env.PI_JUDGE_BACKEND === "systemone") base.backend = env.PI_JUDGE_BACKEND;
	if (env.PI_JUDGE_HEAVY_MODEL !== undefined) base.heavyModel = env.PI_JUDGE_HEAVY_MODEL;
	if (env.PI_JUDGE_LOG) base.log = env.PI_JUDGE_LOG;
	// The llm backend's model name was the one setting with no env override; the default is
	// whatever :8092 serves on the EVO-X3, which a different box will not have.
	if (env.PI_JUDGE_LLM_MODEL) base.llmModel = env.PI_JUDGE_LLM_MODEL;
	if (env.PI_JUDGE_MAX_SWITCH_TOKENS && /^\d+$/.test(env.PI_JUDGE_MAX_SWITCH_TOKENS)) base.maxSwitchTokens = Number(env.PI_JUDGE_MAX_SWITCH_TOKENS);
	return base;
}

// ── the decision spec ─────────────────────────────────────────────────────────────────────
// Keep identical to judge-bench/preflight.py QUESTIONS; that is where it was measured.
const QUESTIONS = {
	turn_type: {
		type: "choice",
		instructions: "What does `user_message` ask for?",
		criteria: {
			chat: "Small talk or a general question that is not about code",
			chat_question: "An explanation of a concept",
			quick_lookup: "Finding where something is in the code",
			single_edit: "One small code change",
			multi_step_task: "A larger task with several steps",
			research: "A broad survey or investigation",
			design_discussion: "A discussion of options and trade-offs",
			other: "Something else",
		},
	},
	is_side_question: { type: "noul", instructions: "Is `user_message` unrelated to the task in `task_frame`?" },
	needs_clarification: { type: "noul", instructions: "Is `user_message` too vague to act on?" },
	needs_files_changed: { type: "noul", instructions: "Does `user_message` request a code change?" },
	needs_memory: { type: "noul", instructions: "Would notes from past sessions in this project help with `user_message`?" },
	swarm_worthy: { type: "noul", instructions: "Does `user_message` describe several independent tasks?" },
	plan_first: { type: "noul", instructions: "Does `user_message` ask for a large or risky change?" },
	task_complexity: {
		type: "score",
		instructions: "What is the scope of `user_message`?",
		criteria: ["A question", "One place in the code", "Several places in the code", "The whole codebase"],
	},
	reasoning_depth: {
		type: "score",
		instructions: "How much careful reasoning does `user_message` require?",
		criteria: ["Recall or lookup", "Straightforward explanation", "Non-obvious analysis", "Deep multi-factor reasoning"],
	},
	tool_complexity: {
		type: "score",
		instructions: "How much tool use does `user_message` require?",
		criteria: ["None", "One or two read-only calls", "Several calls including edits", "Many calls with build or test cycles"],
	},
} as const;

type Answer = { type: string; noul?: number; choice?: string; probabilities?: Record<string, number>; score?: number };
type Answers = Record<string, Answer>;
type Verdict = "yes" | "no" | "unsure";

const zone = (p: number | undefined): Verdict => (p === undefined ? "unsure" : p >= 0.8 ? "yes" : p <= 0.2 ? "no" : "unsure");
// Expected level on the 0..3 rubric; 1.5 (the middle) when the answer is missing.
function scoreOf(a: Answer | undefined): number {
	if (a?.score !== undefined) return a.score;
	if (a?.probabilities) return Object.entries(a.probabilities).reduce((s, [k, v]) => s + Number(k) * v, 0);
	return 1.5;
}

function policy(a: Answers, hasHistory: boolean) {
	const tt = a.turn_type;
	const p = tt?.choice ? tt.probabilities?.[tt.choice] : undefined;
	const turnType = tt?.choice && tt.choice !== "other" && (p === undefined || p >= 0.6) ? tt.choice : "unknown";
	const filesChanged = zone(a.needs_files_changed?.noul);
	const peak = Math.max(scoreOf(a.task_complexity), scoreOf(a.reasoning_depth), scoreOf(a.tool_complexity));
	// mu's gear rule (input-preflight.ts gearFor), unchanged, so the bench numbers apply.
	let gear: Gear;
	if (turnType === "unknown") gear = "standard";
	else if (turnType === "chat") gear = filesChanged === "yes" ? "standard" : "chat";
	else if ((turnType === "chat_question" || turnType === "design_discussion") && filesChanged === "no") gear = "chat";
	else if (turnType === "quick_lookup") gear = peak <= 1.2 ? "light" : "standard";
	else if (peak >= 2.5 || turnType === "research") gear = "heavy";
	else gear = "standard";
	return {
		turnType,
		gear,
		peak: Math.round(peak * 100) / 100,
		verdicts: {
			// With no history there is no main line to be a side question of (mu's rule).
			sideQuestion: hasHistory ? zone(a.is_side_question?.noul) : "no",
			needsClarification: zone(a.needs_clarification?.noul),
			needsFilesChanged: filesChanged,
			needsMemory: zone(a.needs_memory?.noul),
			swarmWorthy: zone(a.swarm_worthy?.noul),
			planFirst: zone(a.plan_first?.noul),
		},
	};
}

// ── backends ──────────────────────────────────────────────────────────────────────────────
async function askSystemone(cfg: Config, state: unknown, signal: AbortSignal) {
	const r = await fetch(`${cfg.url.replace(/\/+$/, "")}/v1/systemone`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: "jev-latest", state, questions: QUESTIONS }),
		signal,
	});
	if (!r.ok) throw new Error(`systemone HTTP ${r.status}`);
	const j = (await r.json()) as { model?: string; answers: Answers };
	return { model: j.model ?? "unknown", answers: j.answers };
}

// Fallback judge: any chat model, one 1-token call per question, option-letter logprobs.
// Measured on Ornith :8092 at 98/6/4, ~1.8 s (halo-prep docs/15). Sequential on purpose: two slots
// did not help (prefill-bound), and a second slot is pi-signal's.
async function askLlm(cfg: Config, state: unknown, signal: AbortSignal) {
	const L = "ABCDEFGH";
	const answers: Answers = {};
	for (const [id, q] of Object.entries(QUESTIONS)) {
		const opts: [string, string][] =
			q.type === "noul"
				? [["true", "Yes"], ["false", "No"]]
				: q.type === "choice"
					? Object.entries(q.criteria).map(([k, v]) => [k, `${k}: ${v}`])
					: q.criteria.map((v, i) => [String(i), v]);
		const lines = opts.map(([, t], i) => `${L[i]}. ${t}`).join("\n");
		const r = await fetch(`${cfg.url.replace(/\/+$/, "")}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: cfg.llmModel,
				messages: [
					{ role: "system", content: "You classify a state. Reply with a single option letter." },
					{ role: "user", content: `State:\n${JSON.stringify(state)}\n\nQuestion: ${q.instructions}\n\n${lines}\n\nAnswer with the letter of one option only.` },
				],
				max_tokens: 1,
				temperature: 0,
				logprobs: true,
				top_logprobs: 20,
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal,
		});
		if (!r.ok) throw new Error(`llm HTTP ${r.status}`);
		const j: any = await r.json();
		const top: { token: string; logprob: number }[] = j.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
		const got: Record<string, number> = {};
		for (const t of top) {
			const k = t.token.trim();
			const i = L.indexOf(k);
			if (i >= 0 && i < opts.length && !(k in got)) got[k] = Math.exp(t.logprob);
		}
		const tot = Object.values(got).reduce((s, v) => s + v, 0) || 1;
		const p = Object.fromEntries(opts.map(([k], i) => [k, (got[L[i]] ?? 0) / tot]));
		if (q.type === "noul") answers[id] = { type: "noul", noul: p.true };
		else if (q.type === "choice") answers[id] = { type: "choice", choice: Object.entries(p).sort((x, y) => y[1] - x[1])[0][0], probabilities: p };
		else answers[id] = { type: "score", probabilities: p, score: Object.entries(p).reduce((s, [k, v]) => s + Number(k) * v, 0) };
	}
	return { model: `llm:${cfg.llmModel}`, answers };
}

// ── state ─────────────────────────────────────────────────────────────────────────────────
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join(" ");
}

// Last few user/assistant turns as short digests, oldest first: the same shape as mu's
// recent_turns. Winnow's window is 64K, but decisive content goes first anyway.
function recentTurns(ctx: ExtensionContext, max = 4, chars = 240): string[] {
	const out: string[] = [];
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0 && out.length < max; i--) {
			const e: any = branch[i];
			if (e.type !== "message") continue;
			const role = e.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const t = textOf(e.message.content).replace(/\s+/g, " ").trim();
			if (!t) continue;
			out.unshift(`${role}: ${t.length > chars ? `${t.slice(0, chars)}…` : t}`);
		}
	} catch {
		// No readable history: judge the message alone.
	}
	return out;
}

// Pick the level closest to `want` that this model supports: the highest supported level at
// or below it, else the lowest above it. thinkingLevelMap null marks a level unsupported.
function pickLevel(model: any, want: Level): Level | undefined {
	if (!model?.reasoning) return undefined;
	const map = model.thinkingLevelMap as Record<string, unknown> | undefined;
	const ok = LEVELS.filter((l) => !map || map[l] !== null);
	const w = LEVELS.indexOf(want);
	const below = ok.filter((l) => LEVELS.indexOf(l) <= w);
	return below.length ? below[below.length - 1] : ok[0];
}

// A thinking change is not free. On :8092 the terse chat template renders a thinking-dependent
// sentence at character 39 of the system prompt, so every change re-reads the whole
// conversation. Measured 2026-09-26: 29.5K tokens cached, then 0 reused after toggling
// thinking off (~1.5 min at 64K depth). mu reached the same conclusion and stopped switching
// per turn. So the level only moves while the conversation is short enough that the re-read
// costs seconds. A model switch (heavy -> GLM) starts cold anyway, so it is exempt.
function switchCost(ctx: ExtensionContext, hasHistory: boolean): { ok: boolean; tokens: number | null } {
	let tokens: number | null = null;
	try {
		tokens = ctx.getContextUsage()?.tokens ?? null;
	} catch {
		// Unknown: decided below.
	}
	// Unknown with history (e.g. right after a compaction): assume it is expensive.
	if (tokens === null) return { ok: !hasHistory, tokens };
	return { ok: tokens <= cfgRef.maxSwitchTokens, tokens };
}
let cfgRef: Config;

// Long pasted text (a document, a log) would make the judge re-read all of it: a 30K-token
// message took Winnow past the timeout (2026-09-26). The request is almost always stated at the
// start or the end, so keep those and say what was cut.
function clip(text: string, head = 3000, tail = 1000): string {
	if (text.length <= head + tail + 200) return text;
	return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters omitted …]\n${text.slice(-tail)}`;
}

function argvHas(...flags: string[]): boolean {
	return process.argv.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
}

// `--model provider/id:high` sets the thinking level too.
function argvModelHasThinking(): boolean {
	const i = process.argv.findIndex((a) => a === "--model" || a.startsWith("--model="));
	if (i < 0) return false;
	const v = process.argv[i].includes("=") ? process.argv[i].split("=")[1] : (process.argv[i + 1] ?? "");
	return /:(off|minimal|low|medium|high|xhigh|max)$/.test(v);
}

// ── the extension ─────────────────────────────────────────────────────────────────────────
export default function judge(pi: ExtensionAPI) {
	const cfg = loadConfig();
	cfgRef = cfg;
	if (cfg.mode === "off") return;

	// Session-scoped routing state. `oursUntil` marks the judge's own model/thinking changes so
	// the select handlers can tell them apart from a human's. A time window, not a flag: pi
	// emits thinking_level_select fire-and-forget (`void emit(...)` in setThinkingLevel, also
	// reached from inside setModel), so the handler can run after a flag would be cleared. A
	// human cannot change either inside the window: the input handler holds the prompt.
	let oursUntil = 0;
	const markOurs = () => {
		oursUntil = Date.now() + 1500;
	};
	const isOurs = () => Date.now() < oursUntil;
	// pi's CLI has no short forms for these three (pi --help, 0.87.1).
	let modelPinned = argvHas("--model", "--provider");
	let thinkingPinned = argvHas("--thinking") || argvModelHasThinking();
	let routedTo: string | undefined; // heavy model this session was moved to (sticky)
	let preRouteModel: string | undefined; // the model it was moved from, for /judge local
	// `/judge local` (or PI_JUDGE_LOCAL=1): never route to a hosted model. The judge keeps
	// answering and routing the thinking level. Unlike the session pins, this is not reset by
	// session_start: once on, it holds for the life of this pi process until toggled off.
	let localOnly = process.env.PI_JUDGE_LOCAL === "1";
	let lastDecisionId: string | undefined;
	// Circuit breaker (halo-prep docs/16 step 4, borrowed from @ejstembler/pi-classifier-router and
	// @riposta/pi-jev): after BREAKER_FAILS consecutive failures, skip the judge for
	// BREAKER_MS instead of making every message wait out the 2.5 s timeout while :8098 is down.
	// The first message after the pause tries again; one more failure re-opens it.
	const BREAKER_FAILS = 3;
	const BREAKER_MS = 5 * 60_000;
	let failures = 0;
	let breakerUntil = 0;
	let sessionId = "";

	function log(rec: Record<string, unknown>) {
		try {
			if (!existsSync(dirname(cfg.log))) mkdirSync(dirname(cfg.log), { recursive: true, mode: 0o700 });
			const fresh = !existsSync(cfg.log);
			appendFileSync(cfg.log, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
			if (fresh) chmodSync(cfg.log, 0o600);
		} catch {
			// Logging must never block a turn.
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		sessionId = ctx.sessionManager.getSessionId?.() ?? "";
		routedTo = undefined;
		lastDecisionId = undefined;
		modelPinned = argvHas("--model", "--provider");
		thinkingPinned = argvHas("--thinking") || argvModelHasThinking();
	});

	pi.on("model_select", async (e, ctx) => {
		if (isOurs() || e.source === "restore") return;
		modelPinned = true;
		routedTo = undefined;
		log({ kind: "override", ts: new Date().toISOString(), session: sessionId, ref: lastDecisionId, what: "model", to: `${e.model.provider}/${e.model.id}`, from: e.previousModel ? `${e.previousModel.provider}/${e.previousModel.id}` : null });
		if (ctx.hasUI) ctx.ui.setStatus("judge", "judge: model pinned");
	});

	pi.on("thinking_level_select", async (e) => {
		if (isOurs()) return;
		thinkingPinned = true;
		log({ kind: "override", ts: new Date().toISOString(), session: sessionId, ref: lastDecisionId, what: "thinking", to: e.level, from: e.previousLevel });
	});

	pi.on("input", async (event, ctx) => {
		try {
			await decide(event, ctx);
		} catch {
			// Fail open.
		}
		return { action: "continue" as const };
	});

	async function decide(event: { text: string; images?: unknown[]; source: string; streamingBehavior?: string }, ctx: ExtensionContext) {
		const text = event.text?.trim() ?? "";
		// Our own re-sent messages, slash commands and templates (expanded after this event,
		// so the raw "/name" says nothing) and empty input are not judged.
		if (cfg.mode === "off" || event.source === "extension" || !text || text.startsWith("/")) return;

		const turns = recentTurns(ctx);
		const state = {
			user_message: clip(text),
			current_action: event.streamingBehavior ? `the agent is mid-run; this message would be delivered as ${event.streamingBehavior}` : null,
			task_frame: null,
			recent_turns: turns,
			has_images: Boolean(event.images?.length),
		};

		const t0 = performance.now();
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
		let res: { model: string; answers: Answers } | undefined;
		let error: string | undefined;
		if (Date.now() < breakerUntil) {
			error = `breaker open until ${new Date(breakerUntil).toISOString()} after ${failures} failures`;
			clearTimeout(timer);
		} else {
			try {
				res = cfg.backend === "llm" ? await askLlm(cfg, state, ac.signal) : await askSystemone(cfg, state, ac.signal);
				failures = 0;
			} catch (e: any) {
				error = ac.signal.aborted ? `timeout ${cfg.timeoutMs} ms` : String(e?.message ?? e);
				if (++failures >= BREAKER_FAILS) breakerUntil = Date.now() + BREAKER_MS;
			} finally {
				clearTimeout(timer);
			}
		}
		const ms = Math.round(performance.now() - t0);
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const verdict = res ? policy(res.answers, turns.length > 0) : undefined;

		// ── act (phases 2 and 3) ──
		const actions: Record<string, unknown> = {};
		// Mid-run input (steer / follow-up) is recorded only: the run it joins is already routed.
		const acting = cfg.mode === "active" && !event.streamingBehavior;
		const cost = switchCost(ctx, turns.length > 0);
		if (acting && !verdict && !thinkingPinned) {
			// No answer: back to the standard level, i.e. what stock pi runs every message at,
			// rather than leaving whatever the previous message was routed to.
			const level = pickLevel(ctx.model, cfg.thinking.standard);
			if (level && level !== pi.getThinkingLevel() && !cost.ok)
				actions.thinking = { kept: pi.getThinkingLevel(), wanted: level, reason: `context ${cost.tokens ?? "unknown"} tokens > ${cfg.maxSwitchTokens}` };
			else if (level && level !== pi.getThinkingLevel()) {
				markOurs();
				pi.setThinkingLevel(level);
				actions.thinking = { to: level, wanted: cfg.thinking.standard, reason: "no answer" };
			}
		}
		if (acting && verdict) {
			// Model first: setModel resets the thinking level (mu's change map, B7).
			if (verdict.gear === "heavy" && localOnly) actions.model = { skipped: "local only (/judge local)" };
			else if (verdict.gear === "heavy" && !modelPinned && !routedTo && cfg.heavyModel.includes("/")) {
				const [prov, ...rest] = cfg.heavyModel.split("/");
				const target = ctx.modelRegistry.find(prov, rest.join("/"));
				if (!target) actions.model = { skipped: `unknown model ${cfg.heavyModel}` };
				else if (!ctx.modelRegistry.hasConfiguredAuth(target)) actions.model = { skipped: `no auth for ${prov}` };
				else {
					try {
						markOurs();
						const before = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
						if (await pi.setModel(target)) {
							preRouteModel = before;
							markOurs(); // its thinking reset may be emitted after it resolves
							// Sticky for the session: switching back and forth would throw away
							// the prompt cache on both sides every time the gear moved.
							routedTo = cfg.heavyModel;
							actions.model = { to: cfg.heavyModel };
						} else actions.model = { skipped: "setModel refused" };
					} catch (e: any) {
						actions.model = { skipped: String(e?.message ?? e) };
					}
				}
			}
			if (!thinkingPinned) {
				const level = pickLevel(ctx.model, cfg.thinking[verdict.gear]);
				const switchedModel = Boolean((actions.model as any)?.to);
				if (level && level !== pi.getThinkingLevel() && !switchedModel && !cost.ok)
					actions.thinking = { kept: pi.getThinkingLevel(), wanted: level, reason: `context ${cost.tokens ?? "unknown"} tokens > ${cfg.maxSwitchTokens}` };
				else if (level && level !== pi.getThinkingLevel()) {
					markOurs();
					pi.setThinkingLevel(level);
					actions.thinking = { to: level, wanted: cfg.thinking[verdict.gear] };
				} else if (level) actions.thinking = { kept: level };
			}
		}

		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
		const rec = {
			kind: "decision",
			id,
			ts: new Date().toISOString(),
			session: sessionId,
			sessionFile: ctx.sessionManager.getSessionFile?.() ?? null,
			cwd: ctx.cwd,
			decision: DECISION,
			version: VERSION,
			mode: cfg.mode,
			backend: cfg.backend,
			judgeModel: res?.model ?? null,
			latencyMs: ms,
			error: error ?? null,
			source: event.source,
			messageChars: text.length,
			streamingBehavior: event.streamingBehavior ?? null,
			state,
			questions: QUESTIONS,
			answers: res?.answers ?? null,
			verdict: verdict ?? null,
			pinned: { model: modelPinned, thinking: thinkingPinned },
			localOnly,
			contextTokens: cost.tokens,
			modelAfter: current,
			thinkingAfter: pi.getThinkingLevel(),
			actions,
		};
		lastDecisionId = id;
		log(rec);
		try {
			pi.appendEntry("judge.decision", rec);
		} catch {
			// The JSONL line is the durable record; the session entry is a convenience.
		}
		if (ctx.hasUI) {
			const g = verdict ? verdict.gear : error ? "no answer" : "?";
			ctx.ui.setStatus("judge", `judge: ${g}${verdict ? ` → ${current?.split("/")[1] ?? "?"} / ${pi.getThinkingLevel()}` : ""}${cfg.mode === "shadow" ? " (shadow)" : ""}${localOnly ? " · local" : ""}`);
		}
	}

	pi.registerCommand("judge", {
		description: "Judge routing: /judge (status) · /judge local (toggle: never route to a hosted model) · /judge unpin · /judge off|shadow|active (this session)",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (a === "local") {
				localOnly = !localOnly;
				let note = "";
				// Turning it on also brings a session that is already on a hosted model home: the
				// point is that nothing further leaves the box, including the next turn.
				if (localOnly && ctx.model && !String(ctx.model.provider).startsWith("local-")) {
					const [prov, ...rest] = (preRouteModel ?? "local-ornith/caveowl-35b-a3b").split("/");
					const target = ctx.modelRegistry.find(prov, rest.join("/"));
					try {
						markOurs();
						if (target && (await pi.setModel(target))) {
							markOurs();
							note = ` · switched back to ${prov}/${rest.join("/")}`;
						} else note = ` · could NOT switch back to ${prov}/${rest.join("/")}; use /model`;
					} catch (e: any) {
						note = ` · could NOT switch back (${String(e?.message ?? e)}); use /model`;
					}
					routedTo = undefined;
				}
				log({ kind: "local", ts: new Date().toISOString(), session: sessionId, localOnly });
				if (ctx.hasUI) ctx.ui.setStatus("judge", `judge: ${localOnly ? "local only" : "hosted routing allowed"}`);
				ctx.ui.notify(
					localOnly
						? `judge: local only — heavy work stays on local models for this pi process${note}. /judge local again to allow GLM.`
						: `judge: hosted routing allowed again (heavy → ${cfg.heavyModel}).`,
					"info",
				);
				return;
			}
			if (a === "off" || a === "shadow" || a === "active") cfg.mode = a;
			if (a === "unpin") {
				modelPinned = false;
				thinkingPinned = false;
				routedTo = undefined;
			}
			ctx.ui.notify(
				`judge ${cfg.mode} · ${cfg.backend} ${cfg.url} · pinned model=${modelPinned} thinking=${thinkingPinned}` +
					` · heavy→${localOnly ? "local only" : (routedTo ?? cfg.heavyModel)} · log ${cfg.log}`,
				"info",
			);
		},
	});
}

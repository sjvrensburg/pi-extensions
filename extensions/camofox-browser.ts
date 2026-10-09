// camofox-browser.ts: one `browser` tool backed by this box's local Camofox (:9377).
//
// Replaces Hermes's browser_* tools (halo-prep docs/13 Phase E, 2026-09-24). Camofox is a
// fingerprint-spoofed Firefox in Docker (halo-prep config/camofox/); this talks to its REST API
// directly, the same request shapes as ~/Projects/coffee-price-tracker/scripts/camofox_client.py.
//
// ONE tool with an `action` enum rather than seven tools: each tool definition is prompt text
// on every request, and the Hermes skill's main rule ("refs go stale after any state change;
// re-snapshot before the next click") is enforced here instead of taught: every action that
// can change the page returns a FRESH snapshot, so the model never holds a stale ref.
//
// Credentials: CAMOFOX_URL / CAMOFOX_API_KEY from ~/.config/pi-jobs/camofox.env (mode 600,
// outside git; they lived in ~/.hermes/.env until 2026-09-24).
//
// Profile: a fixed userId, so cookies and logins persist across sessions on Camofox's profile
// volume (~/.local/share/camofox/profiles). The tab is closed on session shutdown: open tabs
// accumulating across runs OOM'd this Camofox once (camofox_client.py close()).
//
// CAPTCHA and bot-challenge pages (Makro's "Press & Hold") are within reach: `visual_click`
// can locate and click their controls, so there is no principled prohibition against attempting
// them any more.
//
// `visual_click` (2026-09-27): a vision-grounded fallback for the failure mode `click`/`snapshot`
// cannot fix -- confirmed, not guessed: the operator's actual complaint on "highly dynamic
// websites" is a SPARSE accessibility tree (canvas, custom widgets, no ARIA roles), not stale
// refs or timing, which `click`'s ref model has no answer for no matter how it's driven. Backed
// by Fara1.5-9B on :8101 (llama-fara.service; that unit has the model-choice writeup), a
// browser-specialized CUA model, purely for LOCATING the target -- it does not run its own
// multi-step agent loop here (Fara's own harness, fara-cli, does that with its own Playwright
// browser, which was rejected specifically because it would abandon Camofox's fingerprint
// spoofing; see llama-fara.service). One grounding call, one dispatch, done.
//
// Dispatch is `/evaluate`-based synthetic DOM events, NOT a native input API -- Camofox exposes
// none (confirmed against the live API 2026-09-27: click/type take a ref, no coordinate
// endpoint). This works for anything wired to addEventListener/onclick (React, Vue, vanilla JS,
// canvas-internal handlers), confirmed live against a synthetic test page. It does NOT work for
// native browser default actions requiring a trusted event -- plain `<a href>` navigation, native
// form submit -- confirmed the same way (dispatchEvent left `location.href` unchanged on a real
// link). That's a real ceiling, not a bug: for that class of element `click`'s ref path already
// works fine, since a11y trees resolve links and submit buttons without trouble. `visual_click`
// exists for the elements refs can't see in the first place.
//
// Coordinate scale, MEASURED not assumed (learned the hard way on :8100's Qwen3-VL first):
// despite the tool description declaring real pixel dimensions, Fara1.5-9B returns coordinates
// normalized to 0-1000 -- two calibration probes against known on-page pixel positions both
// landed within ~3px after the /1000*dimension rescale. Same quirk, same fix, different model;
// Fara1.5 shares a Qwen3-VL-class vision tower, which is presumably where it comes from. If the
// model is ever swapped, re-run this calibration before trusting `execute`-adjacent behaviour.
//
// Tool-call format, ALSO measured not assumed: passing the OpenAI `tools`/`tool_choice` fields
// makes llama-server try to parse Fara's output against a schema it doesn't match -- Fara emits
// `<function=computer_use><parameter=action>...` (a Hermes-style tag format), llama-server's
// parser expects something else, and the request 500s ("does not match the expected peg-native
// format"). The fix used here is to NOT pass `tools` at all: a plain system-prompt instruction
// asking for `<tool_call>{json}</tool_call>` in `content` gets a clean, regex-parseable result
// every time in testing. Don't "fix" this by switching back to the `tools` field without
// re-testing -- it looks like the more correct API and it is the one that's broken here.
//
// visual_click's `text` argument is screened against the SAME denylist exec-guardrail.ts applies
// to the `bash` tool (KEEP THESE TWO LISTS IN SYNC, same convention as that file's own header
// comment) -- because this is a second, unguarded path for typing arbitrary text, on the same
// abliterated-model box that denylist exists for in the first place. exec-guardrail.ts only
// watches the `bash` tool; nothing about this tool's `text` parameter looks like a shell command,
// so a dangerous string typed into a web form (or a textarea that happens to be a terminal
// emulator embedded in a page) would sail past it untouched without this.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Default is the EVO-X3's Fara unit (:8101); env override so the file deploys unchanged elsewhere.
const FARA_URL = process.env.PI_FARA_URL ?? "http://127.0.0.1:8101/v1/chat/completions";

// Duplicated from exec-guardrail.ts, not imported -- deploy-directory convention in this repo is
// duplicate-with-sync-comment (memory-guard.ts/memory-consolidate.py, exec-guardrail.ts/
// exec_guardrail.py), not cross-extension imports, and this file has never depended on another
// extension's internals. KEEP IN SYNC with that file's DENYLIST.
const ROOT_ADJACENT = "(?:/|/bin|/boot|/etc|/home|/lib|/lib64|/root|/sbin|/usr|/var)";
const VISUAL_DENYLIST: [string, RegExp][] = [
	["rm -rf on / or a root-adjacent path", new RegExp(`\\brm\\b[^|;&\\n]*(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive|--force)[^|;&\\n]*\\s${ROOT_ADJACENT}(?:\\s|$)`)],
	["dd writing to a block device", /\bdd\b.*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/],
	["a filesystem/device wipe (mkfs/wipefs/shred on /dev)", /\b(mkfs(?:\.\w+)?|wipefs|shred)\b.*\s\/dev\//],
	["a redirect writing straight to a block device", /[>]{1,2}\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/],
	["recursive chmod/chown on /", /\b(chmod|chown)\b.*-R.*\s\/(\s|$)/],
	["a fork bomb", /:\s*\(\)\s*\{\s*:\s*\|\s*:?\s*&?\s*\}\s*;\s*:/],
	["a destructive parted/fdisk invocation", /\b(parted|fdisk)\b.*\b(rm|mklabel|--script)\b/],
	["docker system prune --volumes", /\bdocker\s+system\s+prune\b.*--volumes/],
	[
		"systemctl stop/disable/mask/kill against this box's own model or pi units",
		/\bsystemctl\b.*\b(stop|disable|mask|kill)\b.*(llama-[\w-]+|pi-job@|pi-signal|pi-web|winnow)/,
	],
	["pkill/killall targeting llama-server or pi broadly", /\b(pkill|killall)\b.*(llama-server|-f\s+pi\b)/],
];

function matchVisualDenylist(text: string): string | undefined {
	for (const [why, re] of VISUAL_DENYLIST) if (re.test(text)) return why;
	return undefined;
}

const LOG_DIR = join(homedir(), ".local/share/pi-guardrail");
function logVisualDenial(text: string, why: string) {
	try {
		mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
		appendFileSync(
			join(LOG_DIR, "denials.jsonl"),
			JSON.stringify({ ts: new Date().toISOString(), source: "camofox_visual_click", command: text, why }) + "\n",
			{ mode: 0o600 },
		);
	} catch {
		/* a logging failure must not affect the block decision */
	}
}

function pngSize(buf: Buffer): { width: number; height: number } {
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Not Fara's own action vocabulary (which also has visit_url/web_search/pause_and_memorize_fact/
// ask_user_question, per its model card -- an open-ended agent loop this call deliberately isn't
// running). Narrowed to "locate a click target" -- scoped this way on purpose: `text` is always
// typed by THIS code after the click, using the caller's own argument, not left to the model's
// judgment on whether/what to type.
const FARA_ACTIONS = ["left_click", "right_click", "double_click", "triple_click", "left_click_hold"] as const;
type FaraAction = (typeof FARA_ACTIONS)[number];

async function locateWithFara(
	screenshotB64: string,
	width: number,
	height: number,
	target: string,
): Promise<{ action: FaraAction; x: number; y: number; holdMs: number }> {
	const sys =
		"You are a computer use agent. Given a task and a screenshot, call the computer_use tool " +
		"with your next single action.\n\nOutput format:\n<tool_call>\n" +
		'{"name": "computer_use", "arguments": {"action": "left_click", "coordinate": [x, y]}}\n' +
		`</tool_call>\n\nValid actions: ${FARA_ACTIONS.join(", ")}. For left_click_hold include ` +
		'"hold_ms" (default 1000). Only one tool_call, no other text.';
	const body = {
		model: "fara1.5-9b",
		messages: [
			{ role: "system", content: sys },
			{
				role: "user",
				content: [
					{ type: "text", text: `Task: locate and click ${target}` },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${screenshotB64}` } },
				],
			},
		],
	};
	const r = await fetch(FARA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	if (!r.ok) throw new Error(`Fara HTTP ${r.status} (is llama-fara running? systemctl --user start llama-fara)`);
	const data: any = await r.json();
	const content: string = data.choices?.[0]?.message?.content ?? "";
	const m = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
	if (!m) throw new Error(`Fara returned no tool_call. content: ${content.slice(0, 300)}`);
	const parsed = JSON.parse(m[1]);
	const args = parsed.arguments ?? {};
	const action = args.action as FaraAction;
	if (!FARA_ACTIONS.includes(action)) throw new Error(`Fara returned an unexpected action: ${action}`);
	const [rawX, rawY] = args.coordinate as [number, number];
	return {
		action,
		x: Math.round((rawX * width) / 1000),
		y: Math.round((rawY * height) / 1000),
		holdMs: Number(args.hold_ms) || 1000,
	};
}

function clickExpression(x: number, y: number, button: 0 | 1 | 2, clickCount: 1 | 2 | 3): string {
	// Validated live 2026-09-27 against a synthetic onclick-handled element (fired) and a real
	// <a href> link (did not navigate -- untrusted synthetic events don't get native default
	// actions; see the file header). button 0=left 2=right; clickCount>1 sets event.detail so
	// dblclick-detecting listeners see it, and fires a real 'dblclick' at count 2.
	//
	// el.focus() is explicit and deliberate, found by the 2026-10-01 extensive test pass: a
	// synthetic mousedown/click does NOT trigger a real browser's native click-focuses-the-element
	// behaviour (confirmed live -- elementFromPoint correctly found the <input>, but
	// document.activeElement stayed <body> after the full synthetic event sequence). Without this,
	// a visual_click immediately followed by `text` types into whatever had focus before, not the
	// element just "clicked" -- which silently does nothing on a page where nothing was focused.
	// try/catch because focus() throws on some elements (e.g. a plain <div> with no tabindex in
	// some engines) and that must not abort the click itself.
	const opts = `{bubbles:true,cancelable:true,view:window,clientX:${x},clientY:${y},button:${button},detail:${clickCount}}`;
	const seq =
		button === 2
			? `["pointerdown","mousedown","pointerup","mouseup","contextmenu"]`
			: clickCount >= 2
				? `["pointerdown","mousedown","pointerup","mouseup","click","pointerdown","mousedown","pointerup","mouseup","click","dblclick"]`
				: `["pointerdown","mousedown","pointerup","mouseup","click"]`;
	return `(function(){var el=document.elementFromPoint(${x},${y});if(!el)return{ok:false,error:"no element at that point"};try{el.focus();}catch(e){}var opts=${opts};${seq}.forEach(function(t){el.dispatchEvent(new (t.startsWith("pointer")?PointerEvent:MouseEvent)(t,opts));});return{ok:true,tag:el.tagName,id:el.id};})()`;
}

function holdDownExpression(x: number, y: number): string {
	// Same el.focus() fix as clickExpression, same reason.
	const opts = `{bubbles:true,cancelable:true,view:window,clientX:${x},clientY:${y},button:0}`;
	return `(function(){var el=document.elementFromPoint(${x},${y});if(!el)return{ok:false};try{el.focus();}catch(e){}["pointerdown","mousedown"].forEach(function(t){el.dispatchEvent(new (t.startsWith("pointer")?PointerEvent:MouseEvent)(t,${opts}));});window.__cuaHoldEl=el;return{ok:true,tag:el.tagName};})()`;
}

function holdUpExpression(x: number, y: number): string {
	const opts = `{bubbles:true,cancelable:true,view:window,clientX:${x},clientY:${y},button:0}`;
	return `(function(){var el=window.__cuaHoldEl||document.elementFromPoint(${x},${y});if(!el)return{ok:false};["pointerup","mouseup"].forEach(function(t){el.dispatchEvent(new (t.startsWith("pointer")?PointerEvent:MouseEvent)(t,${opts}));});delete window.__cuaHoldEl;return{ok:true};})()`;
}

function typeExpression(text: string): string {
	// Native-setter trick so React/Vue-controlled inputs see the change (a plain el.value= is
	// invisible to them); falls back to textContent for contenteditable. Validated live 2026-09-27
	// against a real oninput-handled field. Does not reach across iframe boundaries or into a
	// canvas's own internal text state -- both out of scope for a DOM-level dispatch.
	return `(function(){var el=document.activeElement;if(!el)return{ok:false,error:"nothing focused"};var setter=(window.HTMLInputElement&&Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")||{}).set||(window.HTMLTextAreaElement&&Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")||{}).set;var text=${JSON.stringify(text)};for(var i=0;i<text.length;i++){var ch=text[i];el.dispatchEvent(new KeyboardEvent("keydown",{key:ch,bubbles:true}));if("value" in el){if(setter)setter.call(el,(el.value||"")+ch);else el.value=(el.value||"")+ch;}else if(el.isContentEditable){el.textContent=(el.textContent||"")+ch;}el.dispatchEvent(new InputEvent("input",{bubbles:true,data:ch,inputType:"insertText"}));el.dispatchEvent(new KeyboardEvent("keyup",{key:ch,bubbles:true}));}return{ok:true};})()`;
}

function loadEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	try {
		for (const line of readFileSync(process.env.PI_CAMOFOX_ENV_FILE ?? join(homedir(), ".config/pi-jobs/camofox.env"), "utf8").split("\n")) {
			const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=["']?(.*?)["']?\s*$/);
			if (m) env[m[1]] = m[2];
		}
	} catch {
		/* no file: fall back to the process environment */
	}
	return env;
}

export default function (pi: ExtensionAPI) {
	const fileEnv = loadEnv();
	const BASE = (process.env.CAMOFOX_URL ?? fileEnv.CAMOFOX_URL ?? "http://127.0.0.1:9377").replace(/\/$/, "");
	const KEY = process.env.CAMOFOX_API_KEY ?? fileEnv.CAMOFOX_API_KEY ?? "";
	const USER = "pi-browser";
	let tabId: string | undefined;

	async function api(method: string, path: string, body?: object, timeoutMs = 60_000): Promise<any> {
		const r = await fetch(BASE + path, {
			method,
			headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await r.text();
		if (!r.ok) throw new Error(`Camofox ${method} ${path.split("?")[0]} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	async function snapshot(offset = 0): Promise<string> {
		const q = `userId=${USER}${offset ? `&offset=${offset}` : ""}`;
		const s = await api("GET", `/tabs/${tabId}/snapshot?${q}`);
		const more = s.hasMore ? `\n[snapshot continues: action "snapshot" with offset ${s.nextOffset}]` : "";
		return `URL: ${s.url}\n${s.snapshot}${more}`;
	}

	// /screenshot returns raw PNG bytes, not JSON -- api() can't be reused, it always JSON.parses.
	async function screenshotPng(): Promise<Buffer> {
		const r = await fetch(`${BASE}/tabs/${tabId}/screenshot?userId=${USER}`, {
			headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok) throw new Error(`Camofox screenshot -> HTTP ${r.status}`);
		return Buffer.from(await r.arrayBuffer());
	}

	async function evaluate(expression: string): Promise<any> {
		const r = await api("POST", `/tabs/${tabId}/evaluate`, { userId: USER, expression });
		return r.result;
	}

	pi.on("session_shutdown", async () => {
		if (!tabId) return;
		tabId = undefined;
		await api("DELETE", `/sessions/${USER}`, undefined, 10_000).catch(() => {});
	});

	pi.registerTool(
		defineTool({
			name: "browser",
			label: "Browser",
			description:
				"A real Firefox (local Camofox) for pages that need JavaScript, clicking, typing or a login. " +
				"For plain reading prefer `curl`; for search use SearXNG. Every action returns the page's " +
				"accessibility tree, whose elements carry refs like e12: click and type by ref, and only with " +
				"refs from the latest result. If an action does not change the page after one retry, stop and " +
				"describe what is on the page.",
			parameters: Type.Object({
				action: StringEnum(["open", "snapshot", "click", "type", "press", "scroll", "back", "close", "visual_click"], {
					description:
						"open: go to url. snapshot: re-read the page (offset to continue a long one). click: ref. " +
						"type: text into ref (submit=true presses Enter). press: a key such as Enter or Escape. " +
						"scroll: direction. back: previous page. close: end the browser session. visual_click: when " +
						"the accessibility tree has no ref for what you need (sparse/empty snapshot despite the page " +
						"visibly having controls -- canvas, custom widgets, no ARIA roles) -- describe the target " +
						"visually instead of by ref, e.g. target=\"the blue Submit button\". Slower and less precise " +
						"than click-by-ref: try ref-based click first, fall back to this only when snapshot gives you " +
						"nothing to click.",
				}),
				url: Type.Optional(Type.String({ description: "For open." })),
				ref: Type.Optional(Type.String({ description: "Element ref from the latest snapshot, e.g. e12." })),
				text: Type.Optional(Type.String({ description: "For type, or for visual_click to type after clicking." })),
				submit: Type.Optional(Type.Boolean({ description: "For type: press Enter afterwards." })),
				key: Type.Optional(Type.String({ description: "For press." })),
				direction: Type.Optional(StringEnum(["down", "up"], { description: "For scroll; default down." })),
				offset: Type.Optional(Type.Number({ description: "For snapshot: continue from this offset." })),
				target: Type.Optional(Type.String({
					description: "For visual_click: a visual description of what to click, e.g. \"the blue Submit button\" or \"the third row's delete icon\".",
				})),
			}),
			async execute(_id, p) {
				const out = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
				const need = (v: unknown, name: string) => {
					if (v === undefined || v === "") throw new Error(`action "${p.action}" needs \`${name}\``);
				};
				try {
					if (p.action === "close") {
						if (tabId) await api("DELETE", `/sessions/${USER}`).catch(() => {});
						tabId = undefined;
						return out("Browser session closed.");
					}
					if (p.action === "open") {
						need(p.url, "url");
						if (tabId) {
							await api("POST", `/tabs/${tabId}/navigate`, { userId: USER, url: p.url });
						} else {
							const t = await api("POST", "/tabs", { userId: USER, listItemId: "pi", url: p.url });
							tabId = t.tabId;
						}
						return out(await snapshot());
					}
					if (!tabId) return out('No page is open: use action "open" with a url first.');
					const ref = (p.ref ?? "").replace(/^@/, "");
					switch (p.action) {
						case "snapshot":
							return out(await snapshot(p.offset ?? 0));
						case "click":
							need(ref, "ref");
							await api("POST", `/tabs/${tabId}/click`, { userId: USER, ref });
							break;
						case "type":
							need(ref, "ref");
							need(p.text, "text");
							await api("POST", `/tabs/${tabId}/type`, { userId: USER, ref, text: p.text });
							if (p.submit) await api("POST", `/tabs/${tabId}/press`, { userId: USER, key: "Enter" });
							break;
						case "press":
							need(p.key, "key");
							await api("POST", `/tabs/${tabId}/press`, { userId: USER, key: p.key });
							break;
						case "scroll":
							await api("POST", `/tabs/${tabId}/scroll`, { userId: USER, direction: p.direction ?? "down", amount: 800 });
							break;
						case "back":
							await api("POST", `/tabs/${tabId}/back`, { userId: USER });
							break;
						case "visual_click": {
							need(p.target, "target");
							if (p.text) {
								const why = matchVisualDenylist(p.text);
								if (why) {
									logVisualDenial(p.text, why);
									return out(
										`visual_click refused: the \`text\` looks like ${why}. This is blocked ` +
											"unconditionally, same as exec-guardrail's bash denylist -- there is no " +
											"confirmation path here. If this was legitimate, an operator has to do it directly.",
									);
								}
							}
							const png = await screenshotPng();
							const { width, height } = pngSize(png);
							const located = await locateWithFara(png.toString("base64"), width, height, p.target!);
							let dispatchResult: any;
							if (located.action === "left_click_hold") {
								await evaluate(holdDownExpression(located.x, located.y));
								await new Promise((res) => setTimeout(res, located.holdMs));
								dispatchResult = await evaluate(holdUpExpression(located.x, located.y));
							} else {
								const button = located.action === "right_click" ? 2 : 0;
								const count = located.action === "triple_click" ? 3 : located.action === "double_click" ? 2 : 1;
								dispatchResult = await evaluate(clickExpression(located.x, located.y, button, count as 1 | 2 | 3));
							}
							if (p.text) await evaluate(typeExpression(p.text));
							return out(
								`visual_click: ${located.action} at (${located.x},${located.y}) on ` +
									`<${dispatchResult?.tag ?? "?"}>${p.text ? `, typed ${JSON.stringify(p.text)}` : ""}\n\n` +
									(await snapshot()),
							);
						}
					}
					return out(await snapshot());
				} catch (e: any) {
					// A vanished tab (Camofox restarted, idle reaper) is recoverable by reopening.
					if (/HTTP 404/.test(e.message)) tabId = undefined;
					const hint = /fetch failed|ECONNREFUSED/.test(e.message)
						? " (is Camofox running? docker ps --filter name=camofox)"
						: "";
					return out(`Browser error: ${e.message}${hint}`);
				}
			},
		}),
	);
}

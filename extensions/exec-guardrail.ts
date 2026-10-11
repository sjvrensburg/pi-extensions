// exec-guardrail.ts: block a fixed set of catastrophic shell commands, unconditionally.
//
// Why this exists: halo-prep docs/pending-cybertiel-swap-plan.md. The operator's hard requirement for
// swapping :8092 to an abliterated model (no refusal backstop of its own) is that something
// OTHER than the model's own judgment stands between it and the box. `judge` (halo-prep docs/15) routes on
// the model's own semantic read of a message and can be talked around by phrasing; this matches
// the literal bytes of the command about to run and cannot. The two are independent layers, not
// alternatives — this runs regardless of what judge decided for the turn.
//
// Deploy target: the one shared ~/.pi/agent/extensions/ directory. Per the plan's finding 2,
// pi-job runs with -nt (no tools at all) and never reaches this. Per findings 4/5, this single
// deploy covers interactive pi, pi-signal and pi-web (the SDK's default tool set includes bash
// unless a caller explicitly overrides it, which none of the three do) with no per-consumer
// wiring. The Omnigent pi_coder worker is NOT reached by this file at all — see
// halo-prep config/omnigent/policies/exec_guardrail.py, which is the second,
// independent implementation of the same list for that harness's own policy engine.
//
// Fail-closed, not fail-open (the opposite of memory-guard.ts, deliberately): pi-signal and the
// Omnigent worker are headless, so there is nobody to answer a confirm dialog, and a crash in the
// matcher must not silently let a catastrophic command through. `terminate: true` is set on every
// block so the agent stops rather than trying a rephrased command in the same turn.
//
// Denials go to their own log (~/.local/share/pi-guardrail/denials.jsonl, mode 600), separate
// from ~/.local/share/pi-judge/decisions.jsonl, so the two audit trails are never confused.
//
// KEEP THIS LIST IN SYNC WITH exec_guardrail.py's DENY_PATTERNS (the dd/mkfs/wipefs/shred/
// fork-bomb/systemctl/pkill rows only -- the Python side delegates rm -rf to Omnigent's own
// blast_radius, which this side approximates with its own regex instead, per the plan's note on
// why rm -rf needs a real flag/path parser and this file deliberately doesn't have one).
//
// The API key store (since 2026-10-11): the operator's keys left ~/.bashrc for
// ~/.config/secrets/api.env, handed out per command by obsidian-keys (~/obsidian-desktop). An
// agent asking that helper or reading the store would get keys it was not started with, so
// SECRET_PATTERNS refuses agent shell commands naming either, and SECRET_DIR refuses pi's file
// tools (read/grep/find/ls/edit/write all take `path`) inside it. This is a tripwire, not a wall:
// `python -c "open(...)"` with the path built from pieces gets past a regex. It is not applied
// to user_bash: there the operator is asking for their own keys. Same row in exec_guardrail.py.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_DIR = join(homedir(), ".local/share/pi-guardrail");
const LOG_FILE = join(LOG_DIR, "denials.jsonl");

// Deliberately narrow approximation for rm -rf /, per the plan's note: a real flag/path parser
// (split -r -f, long flags, path-under-a-critical-dir) already exists in Omnigent's blast_radius
// and is reused as-is on that side. This side has no equivalent library to call, so false
// negatives on obscure rm flag spellings are an accepted gap here, not a design goal.
const ROOT_ADJACENT = "(?:/|/bin|/boot|/etc|/home|/lib|/lib64|/root|/sbin|/usr|/var)";

const DENYLIST: [string, RegExp][] = [
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

const SECRET_DIR = join(homedir(), ".config/secrets");
const SECRET_PATTERNS: [string, RegExp][] = [
	["a read of the API key store", /\bobsidian-keys\b|\.config\/secrets\b|\bsecret-tool\s+lookup\b/],
];

function matchDenylist(command: string): string | undefined {
	for (const [why, re] of DENYLIST) if (re.test(command)) return why;
	return undefined;
}

function matchSecrets(command: string): string | undefined {
	for (const [why, re] of SECRET_PATTERNS) if (re.test(command)) return why;
	return undefined;
}

// A file-tool path inside SECRET_DIR, after ~ expansion and (when it exists) symlink resolution.
function pathInSecrets(raw: unknown, cwd: string): boolean {
	if (typeof raw !== "string" || !raw) return false;
	let p = resolve(cwd, raw.replace(/^~(?=\/|$)/, homedir()));
	try {
		p = realpathSync(p);
	} catch {
		// A path that does not exist yet (write) is checked as given.
	}
	return p === SECRET_DIR || p.startsWith(SECRET_DIR + "/");
}

function logDenial(source: string, command: string, why: string) {
	try {
		mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
		appendFileSync(
			LOG_FILE,
			JSON.stringify({ ts: new Date().toISOString(), source, command, why }) + "\n",
			{ mode: 0o600 },
		);
	} catch {
		// A logging failure must not affect the block decision either way.
	}
}

function notify(source: string, why: string) {
	try {
		// Best-effort, fire-and-forget: a notify failure must never un-block the command, and must
		// never block waiting on signal-send either.
		execFile("signal-send", [`exec-guardrail blocked a ${source} command: ${why}`], () => {});
	} catch {
		// ignore
	}
}

function block(source: string, command: string, why: string) {
	logDenial(source, command, why);
	notify(source, why);
	return {
		block: true,
		terminate: true,
		reason:
			`exec-guardrail: blocked, this looks like ${why}. This command is refused unconditionally ` +
			"-- there is no confirmation path here, by design (halo-prep docs/pending-cybertiel-swap-plan.md). " +
			"If this was legitimate, an operator has to run it directly, outside this session.",
	};
}

export default function execGuardrail(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName !== "bash") {
				const path = (event.input as any)?.path;
				if (!pathInSecrets(path, (ctx as any)?.cwd ?? process.cwd())) return undefined;
				return block(event.toolName, String(path), "a read of the API key store");
			}
			const command = String((event.input as any)?.command ?? "");
			const why = matchDenylist(command) ?? matchSecrets(command);
			if (!why) return undefined;
			return block("bash", command, why);
		} catch {
			// Fail CLOSED, not open (unlike memory-guard.ts): the whole point of this extension is
			// to be the backstop once the model has none of its own, so a crash in the matcher must
			// deny rather than silently let the command through.
			return { block: true, terminate: true, reason: "exec-guardrail: internal error, denying to be safe." };
		}
	});

	// Lower priority than the bash path (a human has to be at the keyboard to hit this), but cheap
	// to cover with the same list since the extension is already loaded.
	pi.on("user_bash", async (event) => {
		try {
			const why = matchDenylist(event.command);
			if (!why) return undefined;
			logDenial("user_bash", event.command, why);
			notify("user_bash", why);
			return {
				result: {
					output: `exec-guardrail: blocked, this looks like ${why}.`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		} catch {
			return {
				result: {
					output: "exec-guardrail: internal error, denying to be safe.",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
	});
}

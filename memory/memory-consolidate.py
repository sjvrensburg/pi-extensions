#!/usr/bin/env python3
"""Nightly consolidation of pi's long-term memory (halo-prep docs/16, step 3). Not a phase.

Run by memory-consolidate.timer (memory/), or by hand:
    memory/memory-consolidate.py            # consolidate + commit
    memory/memory-consolidate.py --dry-run  # show the proposal, write nothing

@pify/memory (a pi package) keeps plain markdown in ~/.pi/agent/memory/: MEMORY.md (global)
and daily/YYYY-MM-DD.md. pify's own `/memory consolidate` needs an interactive confirmation,
so it cannot run headless. This is the offline equivalent, run while nobody is using :8092
(halo-prep docs/16: no daytime background model calls on the two shared slots).

What it does:
  1. `git init` the memory dir the first time, then commit whatever pify wrote during the day
     ("snapshot"). Every nightly state is recoverable with git, independent of pify's own
     recovery records.
  2. If MEMORY.md has at least MIN_ENTRIES bullets, ask Ornith (:8092, thinking OFF) for a
     consolidated version, with pify's own system prompt copied verbatim.
  3. Refuse the proposal with pify's own rules (assessConsolidation in its src/consolidate.ts,
     ported below): no entries left, > 60% of entries dropped, or any entry that appears
     nowhere in the original. Plus one rule of ours: no bullet may contain personal data
     (the same checks as extensions/memory-guard.ts; keep the two in sync).
  4. Write it and commit ("consolidate: N -> M entries"), or log the refusal and leave the file.

Thinking off is not about cache here: this is a fresh prompt either way. It is the #9075/#9512
lesson: thinking can eat the output budget of a summarising call. Daily logs are left alone.
They are dated records, and pify recalls lessons from the last 30 days of them by date.

Exit status: 0 on success, on "nothing to do" and on a refused proposal (all normal outcomes);
non-zero only when the model server is unreachable or git fails. A non-zero exit triggers
notify-failure@ to Signal.
"""
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import os

# pify reads PI_MEMORY_DIR too; the default is its own.
MEM = Path(os.environ.get("PI_MEMORY_DIR", Path.home() / ".pi/agent/memory"))
# Defaults are the EVO-X3's :8092. llama-server serving one model ignores the name, which is
# why MODEL still reads ornith after the 2026-09-27 swap to Cyber-Tiel; env overrides both.
URL = os.environ.get("PI_MEMORY_LLM_URL", "http://127.0.0.1:8092")
MODEL = os.environ.get("PI_MEMORY_LLM_MODEL", "ornith-1.5-35b-a3b")
MIN_ENTRIES = 4  # pify's MIN_ENTRIES_TO_CONSOLIDATE
MAX_REMOVAL_RATIO = 0.6  # pify's MAX_REMOVAL_RATIO
DRY = "--dry-run" in sys.argv

# Verbatim from @pify/memory 0.13.0 src/consolidate.ts (CONSOLIDATE_SYSTEM_PROMPT).
SYSTEM = " ".join([
    "You consolidate a markdown memory file. You are editing a record of facts, not writing prose.",
    "Rules, in order of priority:",
    "(1) Never invent a fact that is not in the input.",
    "(2) When two entries conflict, keep the LATER one — entries are in chronological order and later entries are corrections.",
    "(3) Merge duplicates and near-duplicates into one entry, keeping the most specific wording.",
    "(4) Keep every fact that is not a duplicate or a superseded correction, in its original wording where possible.",
    "(5) Keep the file's heading structure and its bullet-list format.",
    "Output ONLY the consolidated markdown inside one ```markdown fenced block. No commentary.",
])

# Same as extensions/memory-guard.ts CHECKS.
PERSONAL = [
    ("an e-mail address", r"[\w.+-]+@[\w-]+\.[\w.-]{2,}"),
    ("a phone number", r"(?:\+\d{1,3}[\s-]?)?\(?0?\d{2,3}\)?[\s-]?\d{3}[\s-]?\d{4}\b"),
    ("an ID number", r"\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}\b"),
    ("a bank card number", r"\b(?:\d[ -]?){13,19}\b"),
    ("an IBAN", r"\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b"),
    ("a street address", r"\b\d{1,5}\s+(?:[A-Z][\w'-]*\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Crescent|Cres|Close|Way|Boulevard|Blvd|Place|Pl)\b"),
]


def log(msg: str) -> None:
    print(f">> {msg}", flush=True)


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(MEM), *args], check=True, capture_output=True, text=True).stdout


def snapshot(message: str) -> None:
    if not (MEM / ".git").exists():
        git("init", "-q")
        (MEM / ".gitignore").write_text("# pify's search index and recovery records are rebuildable\n*.db\n*.db-*\n")
    git("add", "-A")
    if git("status", "--porcelain").strip():
        git("-c", "user.name=memory-consolidate", "-c", "user.email=memory@evo-x3", "commit", "-q", "-m", message)
        log(f"committed: {message}")


def bullets(text: str) -> list[str]:
    return [l.strip() for l in text.split("\n") if l.strip().startswith(("-", "*"))]


def norm(line: str) -> str:
    line = re.sub(r"^[-*]\s*", "", line)
    line = re.sub(r"^\d{1,2}:\d{2}\s+", "", line)
    return re.sub(r"\s+", " ", line.lower()).strip()


def assess(before: str, after: str) -> str | None:
    """pify's assessConsolidation, plus the personal-data rule. Returns a refusal reason or None."""
    orig = [norm(b) for b in bullets(before)]
    prop = bullets(after)
    if not prop:
        return "the proposal has no entries left"
    removed = max(0, len(orig) - len(prop))
    if orig and removed / len(orig) > MAX_REMOVAL_RATIO:
        return f"it drops {removed} of {len(orig)} entries (over {int(MAX_REMOVAL_RATIO * 100)}%)"
    invented = [b for b in prop if norm(b) and not any(o in norm(b) or norm(b) in o for o in orig)]
    if invented:
        return f"{len(invented)} entr{'y' if len(invented) == 1 else 'ies'} appear nowhere in the original: {invented[:3]}"
    for b in prop:
        for what, rx in PERSONAL:
            if re.search(rx, b):
                return f"an entry contains what looks like {what}: {b[:80]}"
    return None


def parse(text: str) -> str | None:
    t = (text or "").strip()
    m = re.search(r"```(?:markdown|md)?\s*\n([\s\S]*?)```", t, re.I)
    body = (m.group(1) if m else t).strip()
    if not body or (not m and not re.search(r"^[#-]", body, re.M)):
        return None
    return body


def wait_healthy(timeout_s: int = 300) -> None:
    # Persistent=true fires at boot when the box was off overnight; :8092 may still be loading.
    end = time.time() + timeout_s
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"{URL}/health", timeout=5) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(10)
    raise SystemExit(f"{URL} not healthy after {timeout_s} s")


def propose(content: str) -> str:
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Consolidate this memory file (global).\n\n```markdown\n{content.strip()}\n```\n\nReturn the consolidated file in one ```markdown block."},
        ],
        "temperature": 0,  # deterministic: a run and its --dry-run must agree
        "max_tokens": min(16384, len(content) // 2 + 2048),
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(f"{URL}/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        out = json.load(r)
    return out["choices"][0]["message"].get("content") or ""


def main() -> None:
    if not MEM.exists():
        log(f"{MEM} does not exist yet (nothing written to memory so far); nothing to do")
        return
    if not DRY:
        snapshot(f"snapshot {time.strftime('%Y-%m-%d')}")
    target = MEM / "MEMORY.md"
    before = target.read_text() if target.exists() else ""
    n = len(bullets(before))
    if n < MIN_ENTRIES:
        log(f"MEMORY.md has {n} entries (< {MIN_ENTRIES}); not worth a model call")
        return
    wait_healthy()
    t0 = time.time()
    after = parse(propose(before))
    log(f"proposal in {time.time() - t0:.0f} s")
    if after is None:
        log("refused: no markdown in the model's answer")
        return
    reason = assess(before, after)
    if reason:
        log(f"refused: {reason}")
        return
    m = len(bullets(after))
    if DRY:
        print(after)
        log(f"dry run: {n} -> {m} entries, not written")
        return
    if after.strip() == before.strip():
        log("no change proposed")
        return
    target.write_text(after.rstrip() + "\n")
    snapshot(f"consolidate: {n} -> {m} entries")


if __name__ == "__main__":
    main()

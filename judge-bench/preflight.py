#!/usr/bin/env python3
"""Preflight judge bench (halo-prep docs/15-pi-judge.md). Not a phase; run it by hand.

Asks the 10 preflight questions about each of 37 hand-labelled user messages and counts
right / unsure / wrong per field. Two kinds of judge:

  preflight.py http://127.0.0.1:8098 winnow-e4b         # any POST /v1/systemone server
  preflight.py llm:http://127.0.0.1:8092 ornith35       # a chat model, one 1-token call per
                                                        # question, option-letter logprobs
  LLM_CONCURRENCY=2 preflight.py llm:...                # spread those calls over slots

Writes results-<label>.json next to this file (gitignored).

The scenarios (scenarios.json) and the question wording below are mu's `input.preflight`
v4 (github.com/qybaihe/mu, MIT, kyrn/spikes/judge-bench/scenarios.ts), ported as data,
not run. Scoring mirrors mu's policy, because the extension will: yes/no answers are
three-zoned at 0.2/0.8 (the middle is "unsure", i.e. fall back to stock pi), a choice
counts only at p >= 0.6 and not "other". Half the scenarios are Chinese and all are coding
requests -- a sanity bench for wiring and wording, not an evaluation of pi's own traffic.
"""
import json, sys, time, urllib.request, statistics
from pathlib import Path

HERE = Path(__file__).parent
URL = sys.argv[1].rstrip("/") + "/v1/systemone"
LABEL = sys.argv[2] if len(sys.argv) > 2 else "judge"

QUESTIONS = {
    "turn_type": {"type": "choice", "instructions": "What does `user_message` ask for?", "criteria": {
        "chat": "Small talk or a general question that is not about code",
        "chat_question": "An explanation of a concept",
        "quick_lookup": "Finding where something is in the code",
        "single_edit": "One small code change",
        "multi_step_task": "A larger task with several steps",
        "research": "A broad survey or investigation",
        "design_discussion": "A discussion of options and trade-offs",
        "other": "Something else"}},
    "is_side_question": {"type": "noul", "instructions": "Is `user_message` unrelated to the task in `task_frame`?"},
    "needs_clarification": {"type": "noul", "instructions": "Is `user_message` too vague to act on?"},
    "needs_files_changed": {"type": "noul", "instructions": "Does `user_message` request a code change?"},
    "needs_memory": {"type": "noul", "instructions": "Would notes from past sessions in this project help with `user_message`?"},
    "swarm_worthy": {"type": "noul", "instructions": "Does `user_message` describe several independent tasks?"},
    "plan_first": {"type": "noul", "instructions": "Does `user_message` ask for a large or risky change?"},
    "task_complexity": {"type": "score", "instructions": "What is the scope of `user_message`?", "criteria": [
        "A question", "One place in the code", "Several places in the code", "The whole codebase"]},
    "reasoning_depth": {"type": "score", "instructions": "How much careful reasoning does `user_message` require?", "criteria": [
        "Recall or lookup", "Straightforward explanation", "Non-obvious analysis", "Deep multi-factor reasoning"]},
    "tool_complexity": {"type": "score", "instructions": "How much tool use does `user_message` require?", "criteria": [
        "None", "One or two read-only calls", "Several calls including edits", "Many calls with build or test cycles"]},
}
BOOL = {"sideQuestion": "is_side_question", "needsClarification": "needs_clarification",
        "needsFilesChanged": "needs_files_changed", "swarmWorthy": "swarm_worthy", "planFirst": "plan_first"}


def state(inp):
    tf = inp.get("taskFrame")
    return {"user_message": inp["userMessage"], "current_action": inp.get("currentAction"),
            "task_frame": {"goal": tf["goal"], "constraints": tf.get("constraints", []),
                           "current_subgoal": tf.get("currentSubgoal")} if tf else None,
            "recent_turns": inp["recentTurns"]}


def zone(p):
    return "yes" if p >= 0.8 else "no" if p <= 0.2 else "unsure"


def p_true(a):
    return a.get("noul", a.get("probability"))


def score(a):
    if "score" in a: return a["score"]
    if "expected" in a: return a["expected"]
    return sum(int(k) * v for k, v in a["probabilities"].items())


def gear(turn, files, peak):
    if turn == "unknown": return "standard"
    if turn == "chat": return "standard" if files == "yes" else "chat"
    if turn in ("chat_question", "design_discussion") and files == "no": return "chat"
    if turn == "quick_lookup": return "light" if peak <= 1.2 else "standard"
    if peak >= 2.5 or turn == "research": return "heavy"
    return "standard"


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


LETTERS = "ABCDEFGHIJKLMNOP"


def llm_answer(base, st, q):
    """One question to a chat model; read the logprobs of the option letters from a 1-token reply."""
    if q["type"] == "noul":
        opts = [("true", "Yes"), ("false", "No")]
    elif q["type"] == "choice":
        opts = [(k, f"{k}: {v}" if v else k) for k, v in q["criteria"].items()]
    else:
        opts = [(str(i), v) for i, v in enumerate(q["criteria"])]
    lines = "\n".join(f"{LETTERS[i]}. {t}" for i, (_, t) in enumerate(opts))
    msg = (f"State:\n{json.dumps(st, ensure_ascii=False)}\n\nQuestion: {q['instructions']}\n\n{lines}\n\n"
           "Answer with the letter of one option only.")
    out = post(base + "/v1/chat/completions", {
        "messages": [{"role": "system", "content": "You classify a state. Reply with a single option letter."},
                     {"role": "user", "content": msg}],
        "max_tokens": 1, "temperature": 0, "logprobs": True, "top_logprobs": 20,
        "chat_template_kwargs": {"enable_thinking": False}})
    import math
    top = out["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    lp = {}
    for t in top:
        k = t["token"].strip()
        if k in LETTERS[:len(opts)] and k not in lp: lp[k] = math.exp(t["logprob"])
    tot = sum(lp.values()) or 1.0
    p = {opts[i][0]: lp.get(LETTERS[i], 0.0) / tot for i in range(len(opts))}
    if q["type"] == "noul": return {"type": "noul", "noul": p["true"]}
    if q["type"] == "choice": return {"type": "choice", "choice": max(p, key=p.get), "probabilities": p}
    return {"type": "score", "probabilities": p, "score": sum(int(k) * v for k, v in p.items())}


def call(body):
    t = time.perf_counter()
    if LLM:
        from concurrent.futures import ThreadPoolExecutor
        import os
        with ThreadPoolExecutor(int(os.environ.get("LLM_CONCURRENCY", "1"))) as ex:
            futs = {k: ex.submit(llm_answer, LLM, body["state"], q) for k, q in body["questions"].items()}
        out = {"answers": {k: f.result() for k, f in futs.items()}}
    else:
        out = post(URL, body)
    return out, (time.perf_counter() - t) * 1000


LLM = sys.argv[1].rstrip("/")[4:] if sys.argv[1].startswith("llm:") else None


def main():
    scen = json.loads((HERE / "scenarios.json").read_text())
    call({"model": "jev-latest", "state": {"x": 1}, "questions": {"q": {"type": "noul", "instructions": "Is `x` 1?"}}})  # warm
    tally = {}; rows = []; lat = []
    for s in scen:
        out, ms = call({"model": "jev-latest", "state": state(s["input"]), "questions": QUESTIONS})
        lat.append(ms); a = out["answers"]
        tt = a["turn_type"]; probs = tt.get("probabilities", {})
        picked = tt["choice"] if tt["choice"] != "other" and probs.get(tt["choice"], 1) >= 0.6 else "unknown"
        files = zone(p_true(a["needs_files_changed"]))
        peak = max(score(a[k]) for k in ("task_complexity", "reasoning_depth", "tool_complexity"))
        has_main = bool(s["input"].get("taskFrame")) or bool(s["input"]["recentTurns"])
        got = {"turnType": picked, "gear": gear(picked, files, peak)}
        for f, q in BOOL.items():
            got[f] = zone(p_true(a[q])) if (f != "sideQuestion" or has_main) else "no"
        row = {"id": s["id"], "lang": s["lang"], "ms": round(ms), "argmax": tt["choice"], "got": got,
               "p": {q: round(p_true(a[q]), 3) for q in BOOL.values()}, "peak": round(peak, 2), "result": {}}
        for f, exp in s["expect"].items():
            g = got[f]
            if f in BOOL.values() or f in BOOL: r = "unsure" if g == "unsure" else ("right" if g == exp else "wrong")
            elif f == "turnType" and g == "unknown": r = "unsure"
            else: r = "right" if g in exp else "wrong"
            if f == "turnType": row["argmax_ok"] = tt["choice"] in exp
            tally.setdefault(f, {"right": 0, "unsure": 0, "wrong": 0})[r] += 1
            tally.setdefault(f + "@" + s["lang"], {"right": 0, "unsure": 0, "wrong": 0})[r] += 1
            row["result"][f] = r
        rows.append(row)
        print(f'{s["id"]:24} {ms:7.0f} ms  turn={tt["choice"]:<18} gear={got["gear"]:<8} ' +
              " ".join(f'{k}:{v[0]}' for k, v in row["result"].items()), flush=True)
    print(f"\n== {LABEL}: latency p50 {statistics.median(lat):.0f} ms, max {max(lat):.0f} ms (10 questions/request)")
    print(f'{"field":24}{"right":>6}{"unsure":>7}{"wrong":>6}')
    for f in sorted(tally):
        t = tally[f]; print(f'{f:24}{t["right"]:>6}{t["unsure"]:>7}{t["wrong"]:>6}')
    am = [r["argmax_ok"] for r in rows if "argmax_ok" in r]
    print(f"turnType argmax accuracy {sum(am)}/{len(am)}")
    heavy = [r["peak"] for r in rows for s in scen if s["id"] == r["id"] and s["expect"].get("gear") == ["heavy"]]
    light = [r["peak"] for r in rows for s in scen if s["id"] == r["id"] and s["expect"].get("gear") and "heavy" not in s["expect"]["gear"]]
    pairs = [(h > l) + 0.5 * (h == l) for h in heavy for l in light]
    print(f"peak-complexity AUC heavy vs not: {sum(pairs)/len(pairs):.2f} (heavy mean {statistics.mean(heavy):.2f}, other {statistics.mean(light):.2f})")
    (HERE / f"results-{LABEL}.json").write_text(json.dumps({"latency_ms": lat, "tally": tally, "rows": rows}, ensure_ascii=False, indent=1))


main()

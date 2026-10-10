# pi-extensions

Local extensions for [pi](https://github.com/earendil-works/pi), plus the two things that are
coupled to them and must not drift apart: the judge's preflight bench and the nightly memory
consolidation job. Written for one box (the EVO-X3 in `halo-prep`), so every default is that
box's; each box-specific value has an env override, and at the defaults behaviour is unchanged.

Split out of `halo-prep`, the author's private runbook for that box, at commit `5bec25c` on 2026-10-09; history before that lives there
(`config/pi/extensions/`, `scripts/judge-bench/`, `scripts/memory-consolidate.py`). The
`halo-prep docs/NN` references in comments point at that repo's `docs/`, which are not public;
they are kept as provenance.

## What is here

| File | What it does |
|---|---|
| `extensions/exec-guardrail.ts` | Denies a fixed shell denylist on the `bash` tool, unconditionally. Fail-closed. The Omnigent worker is covered by a second, independent copy of the list in `halo-prep config/omnigent/policies/exec_guardrail.py` |
| `extensions/camofox-browser.ts` | One `browser` tool over a local Camofox REST API (fingerprint-spoofed Firefox), with an optional Fara visual-click helper. Repeats exec-guardrail's denylist for typed text |
| `extensions/output-cap.ts` | Caps large tool output as it arrives; full text saved under `~/.local/state/pi-tool-output/` |
| `extensions/memory-guard.ts` | Blocks personal data (e-mail, phone, SA ID, card, IBAN, street address) from `@pify/memory` writes. Fail-open |
| `extensions/schema-key-order.ts` | Reorders tool-schema keys; measured to fix argument drops on a small local model |
| `extensions/judge/` | Routes every message: asks a typed-decision model 10 questions, sets the thinking level per gear, moves heavy work to `zai/glm-5.3`. Logs every decision for fine-tuning |
| `judge-bench/` | Preflight bench for the judge's questions against any `/v1/systemone` server or chat model |
| `memory/` | `memory-consolidate.py` + its user `.service`/`.timer` (03:30): commits and consolidates `~/.pi/agent/memory` with a local model, refusing proposals that drop or invent entries |

## Install

Nothing syncs these; copy by hand, then `diff -r` to check.

```bash
cp extensions/*.ts ~/.pi/agent/extensions/
cp -r extensions/judge ~/.pi/agent/extensions/
cp memory/memory-consolidate.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now memory-consolidate.timer
```

Interactive pi picks extensions up on its next start. **pi-signal and pi-web load them once, at
start: restart both after redeploying** (`systemctl --user restart pi-signal pi-web`). The
memory unit runs the script from this checkout (`%h/Projects/pi-extensions/memory/`), so moving
the checkout breaks it silently until 03:30.

## Environment

| Variable | Default | Used by |
|---|---|---|
| `PI_JUDGE_MODE` | `active` (`off`, `shadow`) | judge |
| `PI_JUDGE_URL` | `http://127.0.0.1:8098` | judge |
| `PI_JUDGE_BACKEND` | `systemone` (or `llm`) | judge |
| `PI_JUDGE_LLM_MODEL` | `cybertiel-coder-35b-a3b` | judge, `llm` backend only |
| `PI_JUDGE_HEAVY_MODEL` | `zai/glm-5.3` (empty disables) | judge |
| `PI_JUDGE_LOG` | `~/.local/share/pi-judge/decisions.jsonl` | judge |
| `PI_JUDGE_MAX_SWITCH_TOKENS` | `8192` | judge |
| `CAMOFOX_URL`, `CAMOFOX_API_KEY` | `http://127.0.0.1:9377`, none | camofox-browser (env wins over the file) |
| `PI_CAMOFOX_ENV_FILE` | `~/.config/pi-jobs/camofox.env` | camofox-browser |
| `PI_FARA_URL` | `http://127.0.0.1:8101/v1/chat/completions` | camofox-browser |
| `PI_OUTPUT_CAP_CHARS`, `PI_OUTPUT_CAP_READ_CHARS` | `12000`, `20000` (0 disables) | output-cap |
| `PI_MEMORY_DIR` | `~/.pi/agent/memory` | memory-consolidate (pify reads it too) |
| `PI_MEMORY_LLM_URL`, `PI_MEMORY_LLM_MODEL` | `http://127.0.0.1:8092`, `ornith-1.5-35b-a3b` | memory-consolidate |

The judge also reads `~/.pi/agent/judge.json`; env wins over it.

## Couplings nothing validates

- **judge ↔ judge-bench.** The questions in `extensions/judge/index.ts` must stay identical to
  `judge-bench/preflight.py` `QUESTIONS`; that is where they were measured. Change a question
  there first, then here, and bump `VERSION`: `decisions.jsonl` is meant to become fine-tuning
  data, and rows from different specs must stay distinguishable.
- **judge ↔ `models.json`.** The judge names `zai/glm-5.3` and reads each model's
  `thinkingLevelMap` from pi's `models.json`. A renamed model routes silently into the
  fail-open path.
- **memory-guard ↔ memory-consolidate.** Both carry the same personal-data regexes
  (`CHECKS`). The guard stops a write; consolidation refuses a proposal containing one. Change
  both or neither.
- **exec-guardrail ↔ camofox-browser ↔ Omnigent policy.** Three copies of one denylist, kept
  in sync by hand (duplicated, not imported: each file deploys alone).
- **Any SDK consumer must call `session.bindExtensions()`**, or `session_start` never fires and
  memory-guard, the judge's session id and pi's memory/search packages silently do nothing.

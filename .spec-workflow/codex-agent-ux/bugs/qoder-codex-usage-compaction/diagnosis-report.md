# Codex automatic compaction: missing usage and false admission rejection

Date: 2026-09-17 (Asia/Shanghai)
Baseline: main, 2137d06914ab927a4c3b5f64b4b67216adf4df65.

## Scope and preserved work

Preserved pre-existing Credits UI changes in zh-CN.json, RequestDetailsTab.js,
Tooltip.js, requestCredits.js and request-credits-column.test.js. They are not
part of this fix or its production artifact. User approved push and production
deployment for this incident, preserving the previous image and v39 rollback.

## Evidence and root causes

Production request at 2026-09-16T15:46:41.891Z succeeded with 523609 input tokens,
459 output tokens and 523264 cached tokens. Adjacent estimates were ~990588.
The router then rejected requests at 15:46:44, 15:46:46 and 15:46:48Z with
estimates 1000718, 1010138 and 1019654, before contacting the upstream.
Thus the incident was NOT evidence that Qoder's real 1M window was exhausted.

The real client rollout (0.154.0-alpha.6.2) records input/output tokens as zero,
no new compacted event, and three context_window_exceeded errors at matching
times. Its displayed 950000 is the effective 95% window marked full after an
error, not a measured token count.

Ranked hypotheses and results:

1. Usage lost during Responses translation: CONFIRMED. sendCompleted omitted
   usage and fired at finish_reason, ahead of trailing choices:[] usage frames.
2. Returning context_length_exceeded automatically compacts: FALSE assumption
   in earlier comments/tests. Codex's session/turn.rs sets usage full and returns
   the error. context_manager/history.rs computes active context from
   last_token_usage.total_tokens plus new local items, not cumulative usage.
3. The remote compaction request itself was rejected: NOT observed in this
   incident; no request was initiated. Actual Codex integration now verifies
   remote compaction initiation, compacted rollout and continuation.
4. True upstream 1M exhaustion: NOT supported by production evidence. The
   heuristic was roughly double upstream usage and caused premature rejection.

Additional regression: OpenAI error chunks were ignored by the Responses
translator and could end in response.completed, including a partial compaction
summary. Failed/truncated compaction must never replace the original history.

Official configuration reference:
https://developers.openai.com/codex/config-reference/
model_auto_compact_token_limit controls automatic history compaction. The
matching local Codex source was consulted for behavior, and the installed
0.154.0-alpha.6.2 binary was used rather than assuming source equivalence.

## Reproduction and validation

Red loops run BEFORE fixes:

```
npm --prefix tests test -- unit/responses-compaction-usage.test.js
# 4 usage assertions failed: response.completed.usage was undefined.

$env:CODEX_TEST_BINARY='<installed Codex executable>'
npm --prefix tests test -- unit/codex-auto-compaction-e2e.test.js
# Failed: real Codex never initiated compaction (compactIndex = -1).

npm --prefix tests test -- unit/codex-proactive-guard.test.js
# Four regressions failed: estimated prompts rejected before upstream call.
```

Fixes:
- Preserve real input, output, cached and reasoning usage without adding a
  buffer or fabricating a token count.
- Wait for usage trailers; complete on [DONE] or EOF, not early finish_reason.
- Apply the same terminal handling to Qoder compaction.
- Forward upstream failures as response.failed; never commit incomplete or
  length-truncated compaction summaries.
- Keep Qoder request estimates diagnostic only. Actual upstream limit errors
  remain errors. Model policy remains 1000000 context / 900000 auto-compaction.
- Correct comments that confused error classification with auto-compaction.

Final local validation:
- 41 targeted test files, 256 tests passed, including real Codex binary tests.
- Four real-client scenarios: 800000 input below threshold; 899950 input + 50
  output at threshold; 900001 input above threshold; mid-turn plan tool call.
- Above-threshold scenarios verify client-generated compaction_trigger, saved
  compacted event, compaction item in continued history and successful response.
- npm run build passed (Next.js production build).
- git diff --check passed.

## Verification boundary and cleanup

The real-client tests use an isolated CODEX_HOME, localhost server, synthetic
upstream counts and synthetic summaries passed through the production stream
translator. They verify the actual client control flow, NOT a paid 900K-token
Qoder inference or the semantic quality of a real long-history summary.
No original conversation was deleted, rewritten or replayed to another provider.

Production validation and deployment are recorded separately after release.
Large single additions that exceed the real upstream window in one step, and
upstreams that omit usage, remain separate limitations; this fix does not claim
that every true upstream context error can recover automatically.

Temporary command logs: OS temp/9router-compaction-{regression,e2e,build}.log.
E2E homes are removed after each run. No temporary production instrumentation
or credentials are committed. An initial test-only Windows directory lock and
parameterized-case bug were corrected before the successful final run.

Prevention: keep the opt-in real Codex executable test in release validation.
Mocks that only submit compaction_trigger cannot test whether Codex initiates
compaction. Do not count context errors as successful compactions.

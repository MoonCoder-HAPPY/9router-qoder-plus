# 9router Qoder Plus Notes

This repository is a full-source fork of `decolua/9router` with Qoder-focused runtime hardening and dashboard additions applied directly to the codebase.

**The canonical document for this fork is [README.md](./README.md)** (Chinese). It carries the current feature list, environment contract, deployment steps and dashboard changes. This file only keeps a short, high-level index; when the two disagree, README.md wins.

## Added Capabilities

- Long sessions: one fixed 1M context window and 900K auto-compaction line for every Qoder model, faithful `response.completed.usage`, end-to-end bridging of Codex compaction items, expandable reasoning summaries, and per-client session isolation on the Qoder side.
- Availability: in-place retry of queued responses, first-SSE-envelope error handling, configurable first-token timeout fallback policy, hidden auto-continue when a turn stops right after announcing the next step, and multimodal image input.
- Quota and alerts: per-API-key Qoder account allocation with per-account priority, per-request credit accounting (CC-Switch compatible `/api/usage` plus the `/user/balance` alias), and DingTalk idle/usage/exhaustion alerts.
- Dashboard: usage details gain a `Credits Used` column and `API Key Name` column plus key-identity filtering; the quota modal streams per-account balances and supports one-click removal of an allocation; the Profile settings page keeps only the retry controls that still apply.

## Runtime Defaults

| Variable | Default | Purpose |
| --- | --- | --- |
| `QODER_QUEUE_MAX_ATTEMPTS` | `15` | Maximum queued retry attempts |
| `QODER_QUEUE_BASE_DELAY_MS` | `5000` | First queued retry wait |
| `QODER_QUEUE_MAX_DELAY_MS` | `60000` | Maximum queued retry wait |
| `QODER_KEEPALIVE_MS` | `10000` | SSE keepalive interval while queued or silent |
| `QODER_TIMEOUT_MAX_ATTEMPTS` | `3` | First-token timeout retry attempts |
| `QODER_TIMEOUT_BASE_DELAY_MS` | `3000` | First-token timeout first retry wait |
| `QODER_TIMEOUT_MAX_DELAY_MS` | `15000` | First-token timeout maximum retry wait |
| `QODER_TIMEOUT_BUDGET_MULTIPLIER` | `2` | Multiplier for the extended timeout budget |
| `QODER_AUTO_CONTINUE_MAX` | `1` | Hidden auto-continue attempts (0 disables) |
| `QODER_STREAM_TIMEOUT_MS` | `600000` | Qoder upstream header timeout |
| `QODER_STALL_TIMEOUT_MS` | `600000` | Qoder stream idle-byte timeout |

The first-token fallback strategy, and the auto-continue count when the environment variable is unset, are also editable under Dashboard -> Profile -> `请求重试与恢复`.

## Model Idle DingTalk Alert

Open Dashboard -> Profile -> Model Idle Alert.

- `Idle Minutes`: alert threshold measured from the latest successful model call.
- `Alert Cooldown`: minimum interval between DingTalk alert messages.
- `DingTalk Webhook`: custom robot webhook URL.
- `DingTalk Secret`: optional DingTalk signed-webhook secret. It is write-only in the settings API response.
- `Message Template`: supports `{idleMinutes}`, `{lastCallAt}`, and `{now}`.

## License

The upstream project is MIT licensed. Keep the original `LICENSE` file and preserve upstream copyright notices.

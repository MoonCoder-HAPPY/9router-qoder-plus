# 9router Qoder Plus Notes

This repository is a full-source fork of `decolua/9router` with Qoder-focused runtime hardening and dashboard additions applied directly to the codebase.

## Added Capabilities

- Qoder HTTP queued responses are retried in place instead of immediately failing the client session.
- Qoder queued/error envelopes emitted as the first SSE event are retried before being surfaced to the client.
- Qoder stream stall and upstream timeout thresholds are configurable by environment variables.
- Qoder retry attempts refresh request IDs and signatures to avoid duplicate-request rejections.
- Qoder resource package quota is parsed from `orgResourcePackage.cap` and displayed in the dashboard.
- Qoder enabled chat model fallbacks use Qoder `display_name` values, including `GLM-5.2`.
- Dashboard Profile includes a Model Idle Alert section for DingTalk webhook alerts when successful model calls have been idle for a configured threshold.

## Runtime Defaults

| Variable | Default | Purpose |
| --- | --- | --- |
| `QODER_QUEUE_MAX_ATTEMPTS` | `15` | Maximum queued retry attempts |
| `QODER_QUEUE_BASE_DELAY_MS` | `5000` | First queued retry wait |
| `QODER_QUEUE_MAX_DELAY_MS` | `60000` | Maximum queued retry wait |
| `QODER_STREAM_TIMEOUT_MS` | `600000` | Qoder upstream header timeout |
| `QODER_STALL_TIMEOUT_MS` | `600000` | Qoder stream idle-byte timeout |

## Model Idle DingTalk Alert

Open Dashboard -> Profile -> Model Idle Alert.

- `Idle Minutes`: alert threshold measured from the latest successful model call.
- `Alert Cooldown`: minimum interval between DingTalk alert messages.
- `DingTalk Webhook`: custom robot webhook URL.
- `DingTalk Secret`: optional DingTalk signed-webhook secret. It is write-only in the settings API response.
- `Message Template`: supports `{idleMinutes}`, `{lastCallAt}`, and `{now}`.

## License

The upstream project is MIT licensed. Keep the original `LICENSE` file and preserve upstream copyright notices.

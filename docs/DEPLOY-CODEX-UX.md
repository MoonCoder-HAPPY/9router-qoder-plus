# Deploying the Codex UX release (codex-agent-ux)

Everything below is **operational**: the code is verified on a shadow instance
(`9router-agentux-test`, 127.0.0.1:20131) before production is touched.

## Artefacts

| Artefact | Value |
| --- | --- |
| Candidate image | `9router:qoder-plus-codex-ux-v40` |
| Rollback container | `9router-before-codex-ux-<date>` (created from `9router:qoder-plus-context-error-v39c`, stopped) |
| Data directory | `/home/ubuntu/.9router` (unchanged schema — no migrations in this release) |

## Pre-flight on the shadow instance

```bash
# contract + scenario acceptance (A: reasoning stream, B: tool call, C: admission guard)
docker exec -e NINER_KEY="<api-key>" 9router-agentux-test \
  node /app/scripts/codex-acceptance.mjs --base http://127.0.0.1:20131 --model DeepSeek-Flash
# expect: 4/4 checks passed
```

Real-client check (Codex CLI), which also seeds the client-side model cache:

```bash
node scripts/codex-models-cache.mjs --base http://<router>:20131 --key <api-key>
RUST_LOG=codex_models_manager=warn codex exec --json "hello" 2>&1 >/dev/null | grep -c "fallback model metadata"
# expect: 0   (and the JSONL should contain an item.completed|reasoning entry)
```

## Switch production

Turnkey path (captures the running container's environment, auto-rolls back when health fails):

```bash
sudo ./scripts/ops/switch-to-codex-ux.sh
```

```bash
docker stop 9router && docker rm 9router
docker run -d --name 9router --restart unless-stopped -p 20128:20128 \
  -v /home/ubuntu/.9router:/app/data \
  -e DATA_DIR=/app/data -e HOSTNAME=0.0.0.0 -e PORT=20128 -e NODE_ENV=production \
  -e REQUIRE_API_KEY=true -e TZ=Asia/Shanghai -e "$JWT_SECRET_ENV" \
  9router:qoder-plus-codex-ux-v40
curl -fsS http://127.0.0.1:20128/api/health   # {"ok":true}
```

## Rollback (single command)

```bash
docker stop 9router && docker rm 9router && docker start 9router-before-codex-ux-<date>
```

## Watch the first hours

```bash
docker logs -f 9router | grep --line-buffered "\[CODEX\]"
# admission_reject / context_peak / timeout_policy / stream_done
docker exec 9router node -e 'const D=require("/app/node_modules/better-sqlite3");const d=new D("/app/data/db/data.sqlite",{readonly:true});
const bad=d.prepare("select count(*) c from requestDetails where status=? and timestamp > ?").get("error", new Date(Date.now()-3600e3).toISOString()).c;
const all=d.prepare("select count(*) c from requestDetails where timestamp > ?").get(new Date(Date.now()-3600e3).toISOString()).c;
console.log("last hour: errors",bad,"of",all)'
```

## Client-side note

Codex does **not** call `/v1/models` for a custom provider: it reads
`~/.codex/models_cache.json`, which expires after **300 seconds** and is bound to the
client version. Run `scripts/codex-models-cache.mjs` before starting Codex (shell alias,
wrapper script or a cron entry) so the client keeps the real context window, compaction
threshold and reasoning capabilities.
## 客户端接入：静态目录（推荐，替代 300 秒缓存）

```bash
# 生成一份包含「客户端自带模型 + 9router 模型」的静态目录
node scripts/codex-models-cache.mjs --base http://<router>:20128 --key <api-key> \
  --catalog-out ~/.codex/models_catalog.json --merge-bundled
```
```toml
# config.toml
model_catalog_json = "/home/<you>/.codex/models_catalog.json"
```

实测（CLI 0.154.0）：两次运行均 `rc=0`、`fallback warnings=0`（含合并进来的 gpt-5.x 辅助模型）、`reasoning items=1`；
而仅用 `~/.codex/models_cache.json` 时缓存 300 秒后即过期，需要重复生成。静态目录是"一次安装、永久生效"的形态。
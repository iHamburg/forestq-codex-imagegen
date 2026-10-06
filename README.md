# ForestQ-codex-imagegen

用你自己的**中转站 API**（OpenAI 兼容接口）生图，并让 **Codex、Claude Code 以及任何 MCP 客户端**都能直接调用。

基于 [qiaomu-codex-imagegen](https://github.com/joeseesun/qiaomu-codex-imagegen)（向阳乔木，MIT）改造：原项目通过 `codex app-server` 借用 Codex 自带的生图能力，必须装好并登录 Codex CLI；这个版本把后端换成 HTTP 直连中转站，**不依赖 Codex CLI**，同时完整保留原项目的出图方法论——先给 ≥4 个风格方向、模板展开提示词、生成后按验收清单检查。

- 零依赖：Node.js 18.17+ 自带 `fetch`，不需要 `npm install`
- 三种入口：MCP server（stdio）、CLI、Agent Skill（`SKILL.md`）
- 两种接口格式，覆盖中转站常见的生图模型

| 接口格式 | 端点 | 适用模型（示例） |
|---|---|---|
| `images` | `/v1/images/generations`，有参考图时走 `/v1/images/edits` | gpt-image-1、dall-e-3、flux-*、seedream、imagen 等 |
| `chat` | `/v1/chat/completions`，参考图以 data URL 发送 | gemini-2.5-flash-image、nano-banana、gemini-3-pro-image-preview、gpt-4o-image、sora_image 等 |

`mode=auto`（默认）会按模型名自动选：名字含 gemini / banana / 4o-image / sora-image / `-all` 的走 chat，其余走 images。chat 返回的图片无论是 markdown 链接、data URL、`message.images[]` 还是 image parts 都能解析。

## 安装

```bash
git clone https://github.com/iHamburg/forestq-codex-imagegen.git ForestQ-codex-imagegen
cd ForestQ-codex-imagegen
./install.sh
```

`install.sh` 会：

1. 交互式写入中转站配置到 `~/.config/forestq-codex-imagegen/config.json`（权限 600）
2. 把本目录软链到 `~/.claude/skills/` 和 `~/.codex/skills/`（之后 `git pull` 两边同时更新）
3. 注册 MCP：Claude Code 用 `claude mcp add -s user`，Codex 追加到 `~/.codex/config.toml`（带 `tool_timeout_sec = 600`，生图常超过默认 60 秒）
4. 跑一次 `doctor` 自检

只要 skill 不要 MCP：`./install.sh --no-mcp`。

### 手动注册 MCP

Claude Code：

```bash
claude mcp add forestq-imagegen -s user -- node /绝对路径/ForestQ-codex-imagegen/scripts/mcp-server.mjs
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.forestq-imagegen]
command = "node"
args = ["/绝对路径/ForestQ-codex-imagegen/scripts/mcp-server.mjs"]
tool_timeout_sec = 600
```

其他 MCP 客户端（Cursor、Cherry Studio 等）同理：`command: node`，`args: [mcp-server.mjs 的绝对路径]`。也可以把 key 放在客户端的 `env` 里，不写配置文件。

## 配置

优先级：**单次调用参数 > 环境变量 > 配置文件 > 默认值**。

| 配置项 | 环境变量 | 说明 |
|---|---|---|
| `base_url` | `FORESTQ_IMAGEGEN_BASE_URL`（回退 `OPENAI_BASE_URL`） | 中转站地址，只写域名会自动补 `/v1`；误贴完整端点也会被裁掉 |
| `api_key` | `FORESTQ_IMAGEGEN_API_KEY`（回退 `OPENAI_API_KEY`） | 中转站 key |
| `model` | `FORESTQ_IMAGEGEN_MODEL` | 默认 `gpt-image-1` |
| `mode` | `FORESTQ_IMAGEGEN_MODE` | `auto` / `images` / `chat` |
| `size_strategy` | `FORESTQ_IMAGEGEN_SIZE_STRATEGY` | 见下文「比例与尺寸」 |
| `exact_pixels` | `FORESTQ_IMAGEGEN_EXACT_PIXELS` | `exact` 策略的目标总像素，默认 1572864（≈1024×1536） |
| `quality` | `FORESTQ_IMAGEGEN_QUALITY` | 如 `high`（gpt-image）、`hd`（dall-e-3） |
| `extra_body` | `FORESTQ_IMAGEGEN_EXTRA_BODY` | JSON，合并进请求体，用于中转站特有参数，如 `{"seed":7}` |
| `edit_field` | `FORESTQ_IMAGEGEN_EDIT_FIELD` | edits 接口的图片字段名，默认单图 `image`、多图 `image[]`；个别中转站要求统一用 `image` |
| `retries` | `FORESTQ_IMAGEGEN_RETRIES` | 429/5xx/网络错误重试次数，默认 2 |
| `timeout_seconds` | `FORESTQ_IMAGEGEN_TIMEOUT` | 单次请求超时，默认 300 |

```bash
node scripts/cli.mjs config set base_url=https://api.your-relay.com/v1 api_key=sk-xxx model=gpt-image-1
node scripts/cli.mjs config            # 查看生效配置（key 打码）
node scripts/cli.mjs doctor            # 免费自检：GET /models，看 key 是否有效、模型是否在列表里
```

配置文件路径可用 `FORESTQ_IMAGEGEN_CONFIG` 改。

### 比例与尺寸

提示词里总会写明比例；`size` 参数按策略决定：

- `standard`（gpt-image / dall-e 默认）：选模型支持的最接近尺寸。gpt-image-1 只有 1024×1024、1536×1024、1024×1536，所以 3:4、16:9 等会出 2:3 / 3:2，结果里会标注「ratio differs」。需要精确比例时加 `crop_to_ratio: true`（CLI `--crop`）居中裁切 PNG。
- `exact`：按比例算出 16 的倍数尺寸（如 3:4 → 1088×1456），适合 flux、seedream 这类支持任意尺寸的模型。
- `auto`：发送 `size: "auto"`。
- `none`（非 OpenAI 模型默认）：不发 size，交给模型按提示词判断。

单次也可直接指定 `size: "1024x1536"`。

## 在 Agent 里用

装好后直接说话即可，例如：

- 「给我几个风格方向，我要做一张咖啡店阅读月的海报」
- 「做一张 16:9 视频封面，用 gemini-2.5-flash-image」
- 「把这张图的背景换成米色纸张，主体不变：/Users/me/a.png」

Agent 会按 `SKILL.md` 的流程：`suggest_directions` 给方向 → 你选 → `compose_prompt` 展开 → `generate_image` 出图 → 读图对照验收清单。

### MCP 工具

| 工具 | 作用 | 是否调 API |
|---|---|---|
| `suggest_directions` | 给出 ≥4 个视觉机制不同的风格方向 | 否 |
| `compose_prompt` | 模板 + 变量展开为最终提示词、避免项、验收清单 | 否 |
| `generate_image` | 生图 / 图生图，保存文件和 `.json` 旁注（提示词、模型、中转站域名，不含 key） | **是** |
| `check_backend` | 显示配置并 `GET /models` 自检 | 是（免费） |
| `search_prompts` / `get_prompt` | 检索本地参考提示词库（可选数据包） | 否 |
| `build_prompt` | 只拼简易路线提示词 | 否 |
| `list_catalog` | 列出后端、场景预设、模板、风格 | 否 |

`generate_image` 相比原版新增：`model`、`api_mode`、`size`、`quality`、`crop_to_ratio`。

## CLI

```bash
node scripts/cli.mjs suggest "咖啡店阅读月" --for 海报
node scripts/cli.mjs compose --template T03-1 --var topic=谷雨 --var subject=嫩芽
node scripts/cli.mjs "清晨窗边读书的猫" --preset xiaohongshu --style airy-illustration
node scripts/cli.mjs "同一构图换成夜景" --ref ./a.png --model gemini-2.5-flash-image
node scripts/cli.mjs "产品海报" --preset poster --crop --quality high --count 2
node scripts/cli.mjs --help
```

默认保存到 `~/Pictures/forestq-codex-imagegen/<日期>/`，`--out` 可改。

## 本地参考提示词库（可选）

与原项目相同：`node scripts/build-corpus.mjs <archive-dir>` 构建到 `~/.local/share/forestq-codex-imagegen/corpus`。如果你已经给原项目建过库（`~/.local/share/qiaomu-codex-imagegen/corpus`），会自动复用。也可用 `FORESTQ_CORPUS_DIR` 指定。

## 常见问题

- **404**：中转站不支持该模型的 Images API → 试 `api_mode: chat`；或检查 `base_url` 是否以 `/v1` 结尾（有的站是 `/api/v1`，照填即可）。
- **401/403**：key 错误或该 key 没有此模型权限。
- **429**：限流或余额不足，会自动重试。
- **chat 模型只回文字没出图**：该模型可能不是生图模型，或被内容策略拒绝，报错里会附上模型原话。
- **需要走代理**：Node 的 `fetch` 默认不读 `HTTPS_PROXY`。Node 24+ 可设 `NODE_USE_ENV_PROXY=1`；国内中转站一般直连即可。
- **Claude Code 里超时**：可设环境变量 `MCP_TOOL_TIMEOUT=600000` 再启动。

## 测试

```bash
npm test     # 内置假中转站，覆盖 images / edits / chat / URL 下载 / 重试 / 鉴权 / 裁切 / 配置优先级，不消耗额度
```

## 致谢与许可

MIT。模板库、场景预设、Mondo 海报方法与 Agent 工作流来自 [qiaomu-codex-imagegen](https://github.com/joeseesun/qiaomu-codex-imagegen)（Copyright (c) 向阳乔木）；模板库提炼自 https://vip.xiaoxiaodong.ai/open-source 公开区样例；Mondo 素材来自 [qiaomu-mondo-poster-design](https://github.com/joeseesun/qiaomu-mondo-poster-design)。中转站后端改造 Copyright (c) ForestQ。

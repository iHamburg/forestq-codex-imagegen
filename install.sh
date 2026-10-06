#!/usr/bin/env bash
# One-shot setup: relay config, skill links for Claude Code + Codex, MCP registration for both.
# Re-runnable. Usage: ./install.sh            (interactive config if none yet)
#                     ./install.sh --no-mcp   (skills + config only)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="forestq-imagegen"
SKILL="forestq-codex-imagegen"
MCP_JS="$ROOT/scripts/mcp-server.mjs"
CLI="node $ROOT/scripts/cli.mjs"
WANT_MCP=1; [[ "${1:-}" == "--no-mcp" ]] && WANT_MCP=0

command -v node >/dev/null || { echo "需要 Node.js 18.17+ (https://nodejs.org)"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 18 )) || { echo "Node.js 版本过低：$(node -v)，需要 18.17+"; exit 1; }
chmod +x "$ROOT/scripts/cli.mjs" "$ROOT/scripts/mcp-server.mjs"

# 1. relay config (stored in ~/.config/forestq-codex-imagegen/config.json, mode 600 — keys stay out of MCP configs)
CONFIG="${FORESTQ_IMAGEGEN_CONFIG:-$HOME/.config/forestq-codex-imagegen/config.json}"
if [[ ! -f "$CONFIG" && -t 0 ]]; then
  echo "== 配置中转站（直接回车跳过，之后可用：$CLI config set …）"
  read -r -p "Base URL（例如 https://api.your-relay.com/v1）: " BASE
  read -r -s -p "API Key: " KEY; echo
  read -r -p "模型 [gpt-image-1]: " MODEL; MODEL="${MODEL:-gpt-image-1}"
  if [[ -n "$BASE" && -n "$KEY" ]]; then $CLI config set "base_url=$BASE" "api_key=$KEY" "model=$MODEL"; fi
fi

# 2. skill folders → symlink to this checkout so `git pull` updates both agents
link_skill() {
  local dir="$1"
  [[ -d "$(dirname "$dir")" ]] || return 0
  mkdir -p "$dir"
  if [[ -e "$dir/$SKILL" && ! -L "$dir/$SKILL" ]]; then echo "跳过 $dir/$SKILL（已存在且不是链接）"; return 0; fi
  ln -sfn "$ROOT" "$dir/$SKILL" && echo "✓ skill → $dir/$SKILL"
}
link_skill "$HOME/.claude/skills"
link_skill "${CODEX_HOME:-$HOME/.codex}/skills"

# 3. MCP servers
if (( WANT_MCP )); then
  if command -v claude >/dev/null; then
    claude mcp remove "$NAME" -s user >/dev/null 2>&1 || true
    claude mcp add "$NAME" -s user -- node "$MCP_JS" && echo "✓ Claude Code MCP: $NAME (user scope)"
  else echo "· 未找到 claude CLI，Claude Code 可手动：claude mcp add $NAME -s user -- node $MCP_JS"; fi

  CODEX_TOML="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if [[ -d "$(dirname "$CODEX_TOML")" ]] || command -v codex >/dev/null; then
    mkdir -p "$(dirname "$CODEX_TOML")"; touch "$CODEX_TOML"
    if grep -q "^\[mcp_servers\.$NAME\]" "$CODEX_TOML"; then echo "· Codex 已有 [mcp_servers.$NAME]，未改动 $CODEX_TOML"
    else
      cat >> "$CODEX_TOML" <<EOF

[mcp_servers.$NAME]
command = "node"
args = ["$MCP_JS"]
startup_timeout_sec = 20
tool_timeout_sec = 600   # image generation can take minutes
EOF
      echo "✓ Codex MCP: [mcp_servers.$NAME] → $CODEX_TOML"
    fi
  fi
fi

echo; echo "== 自检"; $CLI doctor || echo "（自检未通过：用 $CLI config set base_url=… api_key=… model=… 修改后再跑 $CLI doctor）"

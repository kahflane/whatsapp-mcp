<div align="center">

# 📱 WhatsApp MCP

**Give your AI agent a WhatsApp account.**

Read, search, send, schedule, and manage WhatsApp — all through the [Model Context Protocol](https://modelcontextprotocol.io). 87 tools, one process (Node or Bun), your messages in local SQLite.

Works with **any MCP client** — Claude Code, Claude Desktop, Cursor, Windsurf, VS Code (Copilot), OpenAI Codex CLI, OpenCode, Cline, Zed, Goose, and more.

[![Release](https://img.shields.io/github/v/release/kahflane/whatsapp-mcp?style=for-the-badge&logo=github)](https://github.com/kahflane/whatsapp-mcp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/Bun-1.1+-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E56CF?style=for-the-badge)](https://modelcontextprotocol.io)

</div>

---

> [!WARNING]
> **Use a dedicated/burner number.** This is unofficial automation and violates WhatsApp's Terms of Service — your account *can* be banned. Never connect your primary line. New numbers should warm up slowly (~20 messages/day for the first week). You accept this risk.

---

## ✨ What you can do

Ask your assistant things like:

> *“What did the design team say in the group chat today?”*
> *“Send the invoice template to +60123456789 with order #4471.”*
> *“Schedule a birthday message to Rimu for 9am tomorrow.”*
> *“Who voted for option B in yesterday's poll?”*
> *“Post a status to my close friends with this photo.”*

It just works — your assistant drives WhatsApp on your behalf.

## 🎯 Features

| | |
|---|---|
| 💬 **Messaging** | Text, media, location, contacts, polls, events, reactions, edits, replies, forwards, pins |
| 🔎 **Read & search** | Full-text search your whole history offline — chats, contacts, unread, media download |
| 👥 **Groups** | Create, manage members, admin controls, invite links, join requests, metadata |
| 📣 **Status / Story** | Rich text (backgrounds + fonts), image, video, gif, voice — to contacts **and** groups |
| 🗂️ **Chat management** | Archive, pin, mute, star, mark read, disappearing messages |
| 🔐 **Profile & privacy** | Name, about, avatar, block list, privacy settings, presence |
| ⏰ **Automation** | Scheduled messages, reusable templates, keyword auto-replies |
| 🧩 **Interactive** | Buttons, lists, and commerce (product/order) messages |
| 🛡️ **Safety built-in** | Anti-ban send pacing, daily cap, and a one-flip **kill-switch** for all sends |

**[→ See all 87 tools](#-tool-reference)**

## 🚀 Quick start

### 1. Add it to your agent

No install, no token, no path — `npx` (or `bunx`) fetches and runs it on demand. Pick your client below.

> Requires [Node 18+](https://nodejs.org) (for `npx`) **or** [Bun](https://bun.sh) (for `bunx`). Using Bun instead? Swap `npx -y` for `bunx` in any command below.

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add whatsapp -- npx -y @kahflane/whatsapp-mcp
```
</details>

<details>
<summary><b>OpenAI Codex CLI</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.whatsapp]
command = "npx"
args = ["-y", "@kahflane/whatsapp-mcp"]
env = { WA_PAIRING_NUMBER = "", WA_SYNC_FULL_HISTORY = "true", WA_DAILY_CAP = "100" }
```
</details>

<details>
<summary><b>OpenCode</b></summary>

Add to `opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "whatsapp": {
      "type": "local",
      "command": ["npx", "-y", "@kahflane/whatsapp-mcp"],
      "enabled": true
    }
  }
}
```
</details>

<details>
<summary><b>Cursor / Windsurf / Cline / Zed</b></summary>

These read a JSON MCP block (Cursor: `~/.cursor/mcp.json`, Windsurf: `~/.codeium/windsurf/mcp_config.json`, Cline: its MCP settings, Zed: `settings.json` under `context_servers`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@kahflane/whatsapp-mcp"],
      "env": { "WA_PAIRING_NUMBER": "", "WA_SYNC_FULL_HISTORY": "true", "WA_DAILY_CAP": "100" }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop / VS Code Copilot / Goose / any other MCP client</b></summary>

Add the same server block to your client's config (Claude Desktop: `claude_desktop_config.json`, VS Code: `.vscode/mcp.json`, Goose: its extensions config):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@kahflane/whatsapp-mcp"],
      "env": {
        "WA_PAIRING_NUMBER": "",
        "WA_SYNC_FULL_HISTORY": "true",
        "WA_DAILY_CAP": "100"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Prefer to run from source?</b></summary>

```bash
git clone https://github.com/kahflane/whatsapp-mcp.git
cd whatsapp-mcp && bun install
# then point your client at:  bun run /ABSOLUTE/PATH/TO/whatsapp/src/index.ts
```
</details>

### 2. Log in

Restart your MCP client, then just ask your assistant to connect:

1. **“Check WhatsApp status”** → it calls `wa_status`.
2. **“Show me the login QR”** → it calls `wa_get_login_qr`. Scan it in **WhatsApp ▸ Settings ▸ Linked Devices**.
   *(Prefer a code? Set `WA_PAIRING_NUMBER` and ask for the pairing code instead.)*
3. **“Check status again”** → reads `open`. Your history starts syncing into local SQLite.

Auth persists — **you only do this once.** 🎉

## 🧠 How it works

One process is *both* the MCP server and the WhatsApp client — a single long-lived WebSocket shared by every tool, with everything stored in local SQLite.

```
  Your AI assistant
        │  stdio (JSON-RPC)
        ▼
┌──────────────────────────────────────────────┐
│  whatsapp-mcp  (one Node/Bun process)         │
│                                               │
│   MCP Server  ◄──►  Baileys WhatsApp socket   │
│        │                     │                 │
│        └────────►  SQLite ◄──┘                 │
│              (contacts · chats · messages)     │
└──────────────────────────────────────────────┘
```

- **Local-first** — your full history lives on your machine in SQLite. Reading & search work offline.
- **Private** — auth credentials and your message database never leave your computer.
- **Safe by default** — every send is paced with jittered delays + a daily cap, and can be frozen instantly with the kill-switch.

## ⚙️ Configuration

All optional, set via environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Description |
|---|---|---|
| `WA_PAIRING_NUMBER` | *(empty)* | Set a number to log in by code instead of QR |
| `WA_SYNC_FULL_HISTORY` | `true` | Pull full chat history on first sync |
| `WA_DAILY_CAP` | `100` | Max sends per day (anti-ban) |
| `WA_MIN_GAP_MS` / `WA_MAX_GAP_MS` | — | Jittered delay window between sends |
| `WA_AUTH_DIR` / `WA_DATA_DIR` | — | Where auth + database live |
| `WA_LOG_LEVEL` | `warn` | Log verbosity (to stderr) |

## 🧰 Tool reference

<details>
<summary><b>Connection & login</b></summary>

| Tool | Description |
|---|---|
| `wa_status` | Connection, login state, store stats, send counters |
| `wa_get_login_qr` · `wa_get_pairing_code` | First-time login |
| `wa_logout` | Log out and wipe local auth |
| `wa_restrict_sending` | 🛑 Kill-switch — block/allow all outbound sends |
</details>

<details>
<summary><b>Reading & search</b> (works offline)</summary>

| Tool | Description |
|---|---|
| `wa_list_chats` | List chats, newest first |
| `wa_list_contacts` · `wa_resolve_name` | Contacts + name resolution |
| `wa_get_messages` | Read a chat's full messages |
| `wa_search_messages` | Full-text search your history |
| `wa_get_unread` · `wa_mark_read` | Unread tracking + read receipts |
| `wa_fetch_history` | Pull older history (50/call) |
| `wa_history_status` | Sync progress |
| `wa_download_media` | Download + decrypt media to a file |
</details>

<details>
<summary><b>Sending</b></summary>

| Tool | Description |
|---|---|
| `wa_check_number` | Verify numbers are on WhatsApp (anti-ban precheck) |
| `wa_send_text` | Text with mentions / reply / typing |
| `wa_send_media` | Image, video, audio, document, sticker |
| `wa_send_location` · `wa_send_contact` | Location pin · contact card(s) |
| `wa_send_poll` · `wa_get_poll_votes` | Send a poll · read decrypted vote tallies |
| `wa_send_event` | Event card |
| `wa_send_buttons` · `wa_send_list` | Interactive buttons + list messages |
| `wa_react` · `wa_edit_message` · `wa_delete_message` | Modify messages |
| `wa_forward_message` · `wa_pin_message` | Forward · pin in chat |
| `wa_send_broadcast` · `wa_broadcast_info` | Broadcast to a list · query a list |
| `wa_send_product` · `wa_send_order` | Commerce messages (Business accounts) |
</details>

<details>
<summary><b>Status / Story</b></summary>

| Tool | Description |
|---|---|
| `wa_post_status` | Post a story mentioning up to 5 contacts |
| `wa_post_status_to` | Post to a chosen audience (contacts **and** groups) — text with rich backgrounds + fonts, image, video, gif, voice note, audio |
</details>

<details>
<summary><b>Chat management</b></summary>

| Tool | Description |
|---|---|
| `wa_archive_chat` · `wa_pin_chat` · `wa_mute_chat` | Archive · pin · mute (and undo) |
| `wa_mark_chat_read` · `wa_star_message` | Mark read/unread · star a message |
| `wa_delete_chat` · `wa_delete_message_for_me` | Delete chat · clear a message locally |
| `wa_disappearing_chat` | Per-chat disappearing-message timer |
</details>

<details>
<summary><b>Groups</b></summary>

| Tool | Description |
|---|---|
| `wa_create_group` · `wa_groups_list` · `wa_group_metadata` | Create · list all · full metadata |
| `wa_get_group_members` | Participants with names + admin flags |
| `wa_group_participants` | Add / remove / promote / demote |
| `wa_group_update_subject` · `wa_group_update_description` | Rename · set description |
| `wa_group_setting` · `wa_group_add_mode` · `wa_group_ephemeral` | Announce-lock · who-can-add · disappearing |
| `wa_group_invite_code` · `wa_group_join` · `wa_group_info_by_code` | Invite links · join · preview by code |
| `wa_group_join_requests` · `wa_group_join_decision` | List · approve/reject requests |
| `wa_group_member_label` · `wa_group_leave` | Label a member · leave group |
</details>

<details>
<summary><b>Profile, privacy & presence</b></summary>

| Tool | Description |
|---|---|
| `wa_set_name` · `wa_set_status` · `wa_set_picture` · `wa_remove_picture` | Manage your own profile |
| `wa_block` · `wa_blocklist` | Block/unblock · list blocked |
| `wa_get_privacy` · `wa_set_privacy` · `wa_default_disappearing` | Read/set privacy + default timer |
| `wa_get_status` · `wa_get_picture_url` · `wa_get_business_profile` | Someone's about · avatar · business profile |
| `wa_subscribe_presence` · `wa_send_presence` | Subscribe to · broadcast presence |
</details>

<details>
<summary><b>Calls · Scheduling · Templates · Auto-reply</b></summary>

| Tool | Description |
|---|---|
| `wa_reject_call` | Reject an incoming call |
| `wa_schedule_message` · `wa_list_scheduled` · `wa_cancel_scheduled` | Schedule sends (persisted, fires exactly once) |
| `wa_list_templates` · `wa_render_template` · `wa_create_template` · `wa_send_template` | Reusable message templates |
| `wa_autoreply_set` · `wa_autoreply_add_rule` · `wa_autoreply_list_rules` · `wa_autoreply_remove_rule` | Keyword/pattern auto-replies (off by default) |
</details>

## 💡 Good to know

- **Only one server may run at a time** — it owns the auth dir + database. After changing config, restart your MCP client to respawn it.
- **History** arrives in chunks after login; `wa_fetch_history` pages older messages 50 at a time (WhatsApp may not always relay on-demand history to linked devices).
- **Pacing reduces, not eliminates, ban risk.** Respect the daily cap and warm up new numbers slowly.
- **Auto-reply is OFF by default.** Enable it explicitly with `wa_autoreply_set`.

## 🛠️ Tech

[Node](https://nodejs.org) · [Bun](https://bun.sh) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) · [bun:sqlite](https://bun.sh/docs/api/sqlite) · [@innovatorssoft/baileys](https://github.com/innovatorssoft/Baileys) · [Anthropic MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) · TypeScript

## 🤝 Contributing

Issues and PRs welcome. Run `bun run typecheck` and `bun run build` before submitting — they're the verification gates.

## 📄 License

[MIT](LICENSE) © KahfLane

<div align="center">
<sub>Not affiliated with or endorsed by WhatsApp or Meta. Use responsibly and at your own risk.</sub>
</div>

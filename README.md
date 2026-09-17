# sweipe-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code,
Claude Desktop, Cursor, any MCP client) set up a WordPress site running the
[Sweipe](https://mobius.studio/sweipe/) or FlatMobile theme: import a demo, plan and
build a site from a one-paragraph brief, rewrite the copy of existing pages, review the
result, change core settings.

It talks to the theme plugin's `sweipe/v1/agent` REST surface (Companion 1.2.1+) with a
WordPress Application Password. The AI itself runs on the theme's service and is paid
for by the site's licence in monthly credits; no API key is needed anywhere.

## Setup

1. On the site, as an administrator: **Users → Profile → Application Passwords**, add
   one named `mcp`, copy the password.
2. Make sure the theme licence is activated (**Sweipe → License**) and AI is on
   (**Sweipe → AI**).
3. Add the server to your client.

Claude Code:

```bash
claude mcp add sweipe -e SWEIPE_SITE_URL=https://example.com -e SWEIPE_USER=admin -e SWEIPE_APP_PASSWORD="xxxx xxxx xxxx xxxx xxxx xxxx" -- npx -y sweipe-mcp
```

Claude Desktop / Cursor (`mcpServers` entry):

```json
{
  "sweipe": {
    "command": "npx",
    "args": ["-y", "sweipe-mcp"],
    "env": {
      "SWEIPE_SITE_URL": "https://example.com",
      "SWEIPE_USER": "admin",
      "SWEIPE_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
    }
  }
}
```

Application Passwords need HTTPS; on a local `http://` site add
`add_filter( 'wp_is_application_passwords_available', '__return_true' );` to a
must-use plugin.

Works for FlatMobile sites too: the server reads the site's REST index and picks
`sweipe/v1` or `flatmobile/v1` on its own (`SWEIPE_NAMESPACE` overrides).

Optional: `SWEIPE_IMPORT_BUDGET` (seconds the server spends per import step, default
25, max 55; lower it if your host kills long requests).

## Tools

| Tool | What it does | Credits |
| --- | --- | --- |
| `sweipe_status` | Theme, plugin, licence, AI state, where the site plan stands | 0 |
| `sweipe_list_demos` / `sweipe_import_demo` / `sweipe_import_status` | The demo packages and a waiting import | 0 |
| `sweipe_ai_ping` | Service check + credit balance | 0 |
| `sweipe_ai_library` | Templates a site can be planned from | 0 |
| `sweipe_ai_plan` | Brief → plan (pages and sections) | 1 |
| `sweipe_ai_get_plan` | The stored plan | 0 |
| `sweipe_ai_build` | Plan → pages with copy and photos, imported | 4 |
| `sweipe_ai_review` | Render, inspect, screenshot, judge; corrected plan | 5 (fix: 2, free when clean) |
| `sweipe_site_from_brief` | Plan, build, review, rebuild, fix in one call | ~12 |
| `sweipe_brief_pages` / `sweipe_brief_generate` / `sweipe_brief_apply` / `sweipe_brief_undo` | Rewrite the copy of existing pages, with backups | 1 per page |
| `sweipe_brief_pick` | Which demos fit a brief | 0 |
| `sweipe_ai_set_enabled` | AI features on/off | 0 |
| `wp_get_settings` / `wp_update_settings` / `wp_list_pages` | Core title, tagline, timezone, language, front page | 0 |

`SKILL.md` is a plain-English skill file for agents: when to use which tool, what to
check first, what to ask the owner before spending credits.

## The REST surface behind it

Everything the server does is a call to `https://example.com/wp-json/sweipe/v1/agent/…`
with Basic auth; the routes are listed at the top of the plugin's
`plugin/Services/Ai/AgentApi.php`. Any script can use them directly:

```bash
curl -u 'admin:xxxx xxxx xxxx xxxx xxxx xxxx' https://example.com/wp-json/sweipe/v1/agent/status
curl -u '…' -H 'Content-Type: application/json' -d '{"brief":"…","language":"English"}' https://example.com/wp-json/sweipe/v1/agent/ai/plan
```

## Development

```bash
npm install
npm run build
SWEIPE_SITE_URL=http://localhost:8081 SWEIPE_USER=admin SWEIPE_APP_PASSWORD=… node dist/index.js
```

MIT © Mobius Studio

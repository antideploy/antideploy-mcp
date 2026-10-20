# Antideploy in Cursor

## Add the tools

One click, from a browser or a README:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=antideploy&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImFudGlkZXBsb3ktbWNwQDAuMiJdfQ==
```

Or put this in `.cursor/mcp.json` (this project) or `~/.cursor/mcp.json` (every project):

```json
{
  "mcpServers": {
    "antideploy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "antideploy-mcp@0.2"]
    }
  }
}
```

The same file is in [examples/cursor.mcp.json](examples/cursor.mcp.json). Open Cursor's MCP settings and check that `antideploy` is enabled.

## Add the skill

Copy the folder `skills/antideploy` from this repository to `.agents/skills/` (this project) or `~/.agents/skills/` (every project). Cursor also reads `.cursor/skills/` and `~/.cursor/skills/`. The folder must keep the name `antideploy`.

Type `/` in Agent chat and search for `antideploy` to run it by hand. Cursor also uses it by itself when you ask to deploy.

## First deploy

```text
Deploy this project on Antideploy.
```

The agent calls `login` and shows a link and a short code. Open the link, check the code, click Approve. If you have no account, the link creates one. Your login is kept in `~/.antideploy/config.json`, readable only by you, and you can revoke it at https://antideploy.com/tokens.

Cursor asks before running a tool the first time. The files written on your machine are the same as in [Claude Code](claude-code.md#what-it-writes-on-your-machine).

## Without the tools

Skip the setup and paste one sentence into Cursor's agent. It follows a page that explains every step:

```text
Set this project up to deploy on Antideploy. Fetch https://antideploy.com/agent.md and follow it.
```

## Update and remove

The config pins `antideploy-mcp@0.2`, which takes every 0.2.x fix. To move to a new minor version, change that number. To remove, delete the `antideploy` entry from `mcp.json` and the skill folder.

## If the tools do not appear

The first start downloads the package, about 250 kB. The server needs outbound HTTPS to antideploy.com. If your Cursor starts servers outside the project folder, say where the project is by setting `ANTIDEPLOY_PROJECT_DIR` in the entry's `env`.

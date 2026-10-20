# Antideploy in OpenAI Codex

## Add the tools

```bash
codex mcp add antideploy -- npx -y antideploy-mcp@0.2
```

Or edit `~/.codex/config.toml` (every project) or `.codex/config.toml` (a trusted project):

```toml
[mcp_servers.antideploy]
command = "npx"
args = ["-y", "antideploy-mcp@0.2"]
startup_timeout_sec = 60
tool_timeout_sec = 120
```

The same file is in [examples/codex.config.toml](examples/codex.config.toml). Check with `codex mcp list`.

Raise the two timeouts as shown. Codex waits 10 seconds for a server to start by default, and the first start downloads the package. The tool timeout defaults to 60 seconds, and a deploy that uploads a large project can take longer than that.

## Add the skill

Copy the folder `skills/antideploy` from this repository to `.agents/skills/` in your repository, or to `~/.agents/skills/` for every project. You can also ask Codex's skill installer to fetch it from https://github.com/antideploy/antideploy-mcp (the folder is `skills/antideploy`). The folder must keep the name `antideploy`.

## First deploy

```text
Deploy this project on Antideploy.
```

The agent calls `login` and shows a link and a short code. Open the link, check the code, click Approve. If you have no account, the link creates one. Your login is kept in `~/.antideploy/config.json`, readable only by you, and you can revoke it at https://antideploy.com/tokens.

The files written on your machine are the same as in [Claude Code](claude-code.md#what-it-writes-on-your-machine).

## Without the tools

Paste one sentence into Codex. It follows a page that explains every step:

```text
Set this project up to deploy on Antideploy. Fetch https://antideploy.com/agent.md and follow it.
```

That route makes web requests from the agent's own sandbox. If Codex cannot reach antideploy.com, turn network access on for the workspace sandbox in `config.toml`:

```toml
[sandbox_workspace_write]
network_access = true
```

## Update and remove

The config pins `antideploy-mcp@0.2`, which takes every 0.2.x fix. To move to a new minor version, change that number. To remove, delete the `[mcp_servers.antideploy]` table and the skill folder.

## If the tools do not appear

Run `codex mcp list`. The server needs outbound HTTPS to antideploy.com. If Codex starts servers outside your project folder, set `ANTIDEPLOY_PROJECT_DIR` under `[mcp_servers.antideploy.env]`.

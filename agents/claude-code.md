# Antideploy in Claude Code

Two ways in. The plugin installs the tools and the skill together and is the one to use. You can also add only the tools, or only the skill.

## Install the plugin (recommended)

```bash
claude plugin marketplace add antideploy/antideploy-mcp
claude plugin install antideploy@antideploy
```

Or from inside a session:

```text
/plugin install antideploy --marketplace antideploy/antideploy-mcp
```

Start a new session. The plugin adds the Antideploy tools and the `antideploy` skill. It asks for nothing.

## Add only the tools

```bash
claude mcp add antideploy -- npx -y antideploy-mcp@0.2
```

Add `--scope user` to have it in every project. To share it with a team, commit a `.mcp.json` like [examples/claude-code.project-mcp.json](examples/claude-code.project-mcp.json).

## Add only the skill

Copy the folder `skills/antideploy` from this repository into `~/.claude/skills/` (every project) or `.claude/skills/` (this project).

## First deploy

Ask for it in your own words:

```text
Deploy this project on Antideploy.
```

The agent calls `login` and shows you a link and a short code. Open the link, check the code matches, and click Approve. If you have no account, the same link creates one. The agent finishes the login, creates the application, deploys, and tells you the address and which account it went to.

You do this once per machine. The login is kept in `~/.antideploy/config.json`, readable only by you. You can revoke it at any time at https://antideploy.com/tokens.

## What it writes on your machine

| File | What | Commit it? |
| --- | --- | --- |
| `~/.antideploy/config.json` | Your login | No, and it is outside your project |
| `.antideploy.json` | The application this folder belongs to. No secret | Yes |
| `.env`, `.gitignore` | Database and other variables, if you asked for them. `.env` is added to `.gitignore` first | No for `.env` |

## Update, check and remove

```bash
claude plugin update antideploy@antideploy
claude plugin details antideploy
claude plugin uninstall antideploy@antideploy
claude mcp remove antideploy
```

The last line is for the tools-only install. Removing the plugin does not log you out; delete `~/.antideploy/config.json` or ask the agent to log out.

## Project key, for a pipeline

Start Claude Code with `ANTIDEPLOY_API_KEY` set in the environment, to a key made for one application in the console. The plugin's server inherits it, and the tools then work without `login`, bound to that application. Keep the key in your environment, not in a file.

## If the tools do not appear

The first start downloads the package, about 250 kB. Check with `claude mcp list`: `plugin:antideploy:antideploy` should say Connected. The server needs outbound HTTPS to antideploy.com.

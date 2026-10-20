# Antideploy in OpenCode

## Add the tools

Put this in `opencode.json` in your project, or in `~/.config/opencode/opencode.json` for every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "antideploy": {
      "type": "local",
      "command": ["npx", "-y", "antideploy-mcp@0.2"],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

The same file is in [examples/opencode.json](examples/opencode.json). `opencode.jsonc` works too. Check with `opencode mcp list`.

Keep the longer `timeout`. OpenCode waits 5 seconds for a server's tools by default, and the first start downloads the package.

## Add the skill

Copy the folder `skills/antideploy` from this repository to one of these places; OpenCode looks in all of them:

- `.opencode/skills/antideploy` or `~/.config/opencode/skills/antideploy`
- `.agents/skills/antideploy` or `~/.agents/skills/antideploy`
- `.claude/skills/antideploy` or `~/.claude/skills/antideploy`

The folder name must be `antideploy`, which is also the skill's name. OpenCode lists skills for the agent, which loads one when your request matches its description.

## First deploy

```text
Deploy this project on Antideploy.
```

The agent calls `login` and shows a link and a short code. Open the link, check the code, click Approve. If you have no account, the link creates one. Your login is kept in `~/.antideploy/config.json`, readable only by you, and you can revoke it at https://antideploy.com/tokens.

The files written on your machine are the same as in [Claude Code](claude-code.md#what-it-writes-on-your-machine).

## Without the tools

Paste one sentence into OpenCode. It follows a page that explains every step:

```text
Set this project up to deploy on Antideploy. Fetch https://antideploy.com/agent.md and follow it.
```

## A project key, for a pipeline

OpenCode reads environment variables in config as `{env:NAME}`. Add this inside the `antideploy` entry, with the key in your environment and never in the file:

```json
"environment": { "ANTIDEPLOY_API_KEY": "{env:ANTIDEPLOY_API_KEY}" }
```

## Update and remove

The config pins `antideploy-mcp@0.2`, which takes every 0.2.x fix. To move to a new minor version, change that number. To remove, delete the `antideploy` entry and the skill folder.

## If the tools do not appear

Run `opencode mcp list` and `opencode mcp debug antideploy`. The server needs outbound HTTPS to antideploy.com. If OpenCode starts servers outside your project folder, add `"ANTIDEPLOY_PROJECT_DIR": "/path/to/project"` to `environment`, or use the entry's `cwd` option.

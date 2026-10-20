# Antideploy plugin

Deploy and run applications on [Antideploy](https://antideploy.com) from Claude Code or Cursor. You ask the agent to deploy your project. It shows you one link; you open it and click Approve. Then it creates the application and its database, deploys, reads the logs, and tells you where your app is live and on which account. No dashboard, no Dockerfile, no key to copy, and no GitHub repository needed.

## What this plugin contains

- **The Antideploy tools**, an MCP server that the plugin starts with `npx -y antideploy-mcp@0.2.0`. It is an open source package, [antideploy-mcp on npm](https://www.npmjs.com/package/antideploy-mcp), and its source is in the repository this plugin comes from. The plugin pins an exact version, so what runs is what was reviewed.
- **The `antideploy` skill**, which tells the agent when Antideploy fits, how to connect, how to deploy, what to read when a deploy fails, and when to use a different host instead of forcing this one.

## What it does on your machine

- It sends your project folder to antideploy.com when you ask it to deploy. It never sends a `.env` file, `node_modules`, build output, private keys or Python virtualenvs.
- It saves your login in `~/.antideploy/config.json`, readable only by you. You can revoke it at any time at https://antideploy.com/tokens.
- It writes `.antideploy.json` in your project, which names the application the folder belongs to and holds no secret, and, when you ask for a database, a `.env` file that it adds to `.gitignore` first.
- It never shows a token or a password to the agent.
- It does not delete applications or databases; those stay in the Antideploy console.

## Settings

The plugin asks for nothing. For a pipeline, or a machine where you cannot approve a link, you can start Claude Code with `ANTIDEPLOY_API_KEY` set to a project key made for one application in the Antideploy console; the tools then work without signing in, bound to that application. A project key is a password, so keep it in your environment and out of files.

## Install

```bash
claude plugin marketplace add antideploy/antideploy-mcp
claude plugin install antideploy@antideploy
```

Full guides for Claude Code, Cursor, Codex and OpenCode: https://antideploy.com/docs/deploying/mcp

Support: https://antideploy.com/contact. Privacy policy: https://antideploy.com/privacy. Terms: https://antideploy.com/terms. License: MIT.

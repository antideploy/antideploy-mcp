# antideploy-mcp

Deploy and run applications on [Antideploy](https://antideploy.com) from inside a coding agent: Claude Code, Cursor, Codex, OpenCode, or anything that speaks MCP.

You describe what you want built. The agent writes it, signs in with one link you approve, creates the application and its database, deploys it, and tells you where it is live. No dashboard, no Dockerfile, no YAML, no key to copy, and no GitHub repository needed.

```
you  ->  agent writes the app  ->  you approve one link  ->  https://your-app.antideploy.app
```

## Install

Pick your agent. Each guide has the exact commands, the config file, the skill, and how to update and remove.

| Agent | Quickest install | Guide |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace add antideploy/antideploy-mcp` then `claude plugin install antideploy@antideploy` | [agents/claude-code.md](agents/claude-code.md) |
| Cursor | The install link in the guide, or `.cursor/mcp.json` | [agents/cursor.md](agents/cursor.md) |
| OpenAI Codex | `codex mcp add antideploy -- npx -y antideploy-mcp@0.2` | [agents/codex.md](agents/codex.md) |
| OpenCode | An `mcp` entry in `opencode.json` | [agents/opencode.md](agents/opencode.md) |
| Any other MCP client | Command `npx`, arguments `-y antideploy-mcp@0.2` | below |

Nothing to install by hand. The agent runs the server with `npx`, which downloads one package of about 250 kB the first time.

```json
{
  "mcpServers": {
    "antideploy": { "command": "npx", "args": ["-y", "antideploy-mcp@0.2"] }
  }
}
```

No agent with MCP? Paste one sentence instead. The agent follows a page that explains every step:

```text
Set this project up to deploy on Antideploy. Fetch https://antideploy.com/agent.md and follow it.
```

## The first deploy

```text
Deploy this project on Antideploy.
```

1. The agent calls `login` and shows you a link and a short code.
2. You open the link, check the code matches, and click **Approve**. If you have no account, the same link creates one. This is the only thing you do.
3. The agent calls `create_application` (which records the application in `.antideploy.json`), creates a database if the project needs one, and calls `deploy`.
4. It polls until the app is live and tells you the address and which Antideploy account it went to.

You sign in once per machine. The login lives in `~/.antideploy/config.json`, readable only by you, and you can revoke it at any time at [antideploy.com/tokens](https://antideploy.com/tokens).

## The skill

[`skills/antideploy`](skills/antideploy/SKILL.md) is an agent skill: it tells the agent when Antideploy fits, how to connect, how to deploy, what to read when something fails, and when to use a different host instead. It works in Claude Code, Cursor, Codex and OpenCode, which all read the same `SKILL.md` format. The Claude Code plugin installs it for you; the other guides say where to copy it.

## Tools

Everything is a thin wrapper over the platform's HTTP API, which describes itself at [antideploy.com/api/v1](https://antideploy.com/api/v1).

| Group | Tools |
| --- | --- |
| Sign in | `login`, `logout` |
| Applications | `list_applications`, `create_application`, `link_application`, `check_address`, `app_settings`, `update_app_settings` |
| Deploy | `deploy`, `deployment_status`, `redeploy`, `rollback`, `deployment_history` |
| Variables | `list_env`, `set_env`, `set_env_from_file`, `remove_env`, `request_keys` |
| Run it | `logs`, `health`, `metrics`, `list_schedules`, `add_schedule`, `set_schedule_enabled`, `remove_schedule` |
| Database | `database_info`, `database_create`, `database_env_to_file` |
| Storage, sign-in, email for the app | `storage_create`, `storage_env_to_file`, `auth_create`, `auth_env_to_file`, `email_create`, `email_env_to_file`, `email_status`, `email_activity`, `email_deliverability`, `email_domain`, `email_overview`, `email_pause`, `email_resume`, `email_test`, `email_remove` |
| Checks and AI | `security_scan`, `security_scan_status`, `ai_wallet`, `create_ai_key`, `api_info` |

Deploys are asynchronous. `deploy`, `redeploy` and `rollback` hand back a `taskId`; poll `deployment_status` until it reports `succeeded` or `failed`.

Not offered, on purpose: deleting an application or its database, custom domains, billing, and adding money to the AI wallet. Those stay in the [console](https://antideploy.com/console), where a person does them deliberately.

## Secrets and files

- **Tokens and passwords never enter the conversation.** `login` does not show the token. `database_env_to_file` and the other `*_env_to_file` tools write the variables straight into a `.env*` file inside the project and answer with their names only. They add the file to `.gitignore` before writing it.
- **A `.env` file is never uploaded.** Neither are `node_modules`, build output, private keys or Python virtualenvs. The deploy result names any `.env` files it left out. To store variables from one, call `set_env_from_file` with the names: it reads the file locally, sends only those, and never shows a value. It refuses the names the platform sets itself (`DATABASE_URL`, `PG*`, storage, sign-in and email variables, the application's own address and generated signing secrets).
- **Keys only you have.** `request_keys` gives you a page on antideploy.com to paste a Stripe key or a bot token into, so the agent never sees it.
- **One application at a time, never guessed.** A folder is tied to its application by `.antideploy.json` (an id, no secret; commit it). A folder without one is refused, not matched to an application by guesswork.
- **Only the project folder.** The tools act inside the folder the server was started in (or `ANTIDEPLOY_PROJECT_DIR`). A folder named in a call must be inside it, a home directory or a drive is refused as a project, and nothing is written through a symbolic link. An agent working in a repository you did not write cannot be talked into sending another folder to Antideploy or writing a secret outside the project.

## Limits

The upload limits are read from the platform at deploy time, so they follow its contract: currently 4,000 files and 28 MB for a project, and 28 MB for any one file. One deploy at a time per application. A larger project deploys from GitHub instead. The platform's own limits on plans, databases and what it cannot run are listed at [antideploy.com/blog/what-antideploy-cannot-run](https://antideploy.com/blog/what-antideploy-cannot-run).

## Configuration

All optional.

| Variable | |
| --- | --- |
| `ANTIDEPLOY_API_KEY` | A project key for one application, made in the console (starts with `ad_`). For a pipeline or a second machine. A server started with one is bound to that application and works without `login`. |
| `ANTIDEPLOY_URL` | Defaults to `https://antideploy.com`. A login for any other address is kept in its own file, so a test server never replaces your real login. |
| `ANTIDEPLOY_PROJECT_DIR` | The project folder, for a client that starts servers somewhere else. Defaults to the working directory. |

## Development

```bash
npm install
npm test            # the server over stdio against a stand-in platform, units, packaging
npm run build       # one bundled file in dist/
npm run test:bundle # the same end-to-end suite against the bundle
```

The end-to-end tests start the real server as an agent does, with a throwaway home directory, against a local stand-in for the API (`test/fake-antideploy.mjs`). They send nothing to antideploy.com. Whether the real platform keeps the contract is checked separately; see [ACCEPTANCE.md](ACCEPTANCE.md).

`npm run build` bundles the server and its dependencies into one file, so a first `npx` start has nothing to resolve.

## What Antideploy does with what you send

It reads the source and works out the runtime, framework, build and start commands, the port and the environment variables the code references, citing the file each conclusion came from. It provisions what the app needs, including a Postgres database with `DATABASE_URL` set, builds it, releases it behind HTTPS, and keeps it running with health checks, logs and rollback. Full documentation: [antideploy.com/docs](https://antideploy.com/docs).

## License

MIT

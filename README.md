# antideploy-mcp

Deploy an application to [Antideploy](https://antideploy.com) from inside a coding
agent. Claude Code, Cursor, Windsurf, Codex, anything that speaks MCP.

You describe what you want built. The agent writes it, then deploys it, without
either of you writing a Dockerfile, a YAML file, or touching a cloud console.

```
you  ─▶  agent writes the app  ─▶  deploy  ─▶  https://your-app.antideploy.com
```

## Install

Nothing to install. The agent runs it with `npx`.

### Claude Code

```bash
claude mcp add antideploy -e ANTIDEPLOY_API_KEY=ad_your_key -- npx -y antideploy-mcp
```

### Cursor, Windsurf, and anything else with an `mcp.json`

```json
{
  "mcpServers": {
    "antideploy": {
      "command": "npx",
      "args": ["-y", "antideploy-mcp"],
      "env": { "ANTIDEPLOY_API_KEY": "ad_your_key" }
    }
  }
}
```

## Getting a key

Create an application at [antideploy.com](https://antideploy.com), then create an
API key for it. **The key identifies the application**, so you never pass an
application id: one key, one app. That is deliberate: this key ends up pasted
into a project directory, which means it will eventually be committed or
screenshotted, so it is scoped to a single application, can write secrets but
never read them back, and can be revoked on its own.

Deploying somewhere new means a new app and a new key.

## Tools

| Tool | What it does |
| --- | --- |
| `deploy` | Packages the project directory and deploys it. Returns a `taskId`. |
| `deployment_status` | Progress for one deploy: steps, the analyzed spec, warnings, hazards. |
| `list_env` | Environment variable names. Values are never returned. |
| `set_env` | Store or replace environment variables. |
| `redeploy` | Build again without sending the code. This is how a changed variable or a new AI key reaches the running app. `latest` deploys a GitHub application's newest commit. |
| `remove_env` | Remove one environment variable. |
| `deployment_history` | Recent deploys, with the failure sentence for any that failed. |
| `logs` | What the running container has printed. |
| `health` | Whether it is serving, and when that was last checked. |
| `metrics` | Requests, server errors, and p50 and p95 response times. |
| `rollback` | Put back the last version that went live before this one, or a specific one. |
| `app_settings` | The address, source, `deployOnPush` and root directory. |
| `update_app_settings` | Change the address, `deployOnPush` (GitHub applications) or the root directory. |
| `list_schedules`, `add_schedule`, `set_schedule_enabled`, `remove_schedule` | Scheduled jobs: call a path on the application on a cron schedule, in UTC. |
| `database_info` | The application's database: state, size, tables, connection string masked. |
| `database_create` | Create the application's Postgres now, before its first deploy, so the project is written against the real database. Idempotent. The deploy later reuses it. |
| `database_env_to_file` | Write `DATABASE_URL` and the `PG*` variables into `.env` and return only their names, so the password never enters the conversation. Needs the account token saved by the connect step. |
| `security_scan`, `security_scan_status` | Scan the live app for common vulnerabilities, and read the findings. |
| `ai_wallet`, `create_ai_key` | The AI wallet balance, and an AI key saved into the application as `OPENROUTER_API_KEY` (the secret is never shown to the agent). |
| `api_info` | The platform API's own description of itself. |

Deploys are asynchronous. `deploy`, `redeploy` and `rollback` hand back a
`taskId`; poll `deployment_status` until it reports `succeeded` or `failed`.

Not here, because a project key is not allowed them: reading rows from the
database, and creating more keys. An agent that can run commands can do both
with an account token (see `https://antideploy.com/agent.md`). Custom domains,
deleting an application and billing stay in the dashboard.

### Building against the database before the first deploy

`database_create` works with the project key alone. Reading the connection
string does not, because a project key is made to be committed and must not be
able to read a database. `database_env_to_file` therefore uses the **account
token** that connecting through [antideploy.com/agent.md](https://antideploy.com/agent.md)
saves at `~/.antideploy/config.json`. It reads that file at the moment it needs
it, never from this server's environment (where it would end up in a config file
that gets committed), and uses it for the one application the key names. It
writes only to a `.env*` file inside the project directory, replaces variables
that are already there instead of adding a second copy, and adds the file to
`.gitignore`. Without the token it says how to get one.

## Two things worth knowing

**The whole directory is sent, not just the entry point.** The single most common
way to break a deploy on this platform is to upload one file: it builds fine,
starts fine, and then serves a page whose every asset 404s.

**A `.env` in the directory is uploaded on purpose.** Its values go into
Antideploy's encrypted secret store and the file itself is dropped from the build
context, so you don't retype nine API keys you already have on disk. If that is
not what you want, move the file before deploying.

Skipped automatically: `node_modules`, `.git`, build output (`dist`, `build`,
`.next`, `target`, …), virtualenvs, editor and tool caches, and private keys
(`*.pem`, `*.key`, `id_rsa`, …).

## Limits

| | |
| --- | --- |
| Files | 4,000 |
| Per file | 5 MB |
| Total upload | 28 MB |
| Concurrent deploys | 1 per application |

Checked locally before anything is uploaded, so hitting one costs you an error
rather than a transfer.

## Configuration

| Variable | |
| --- | --- |
| `ANTIDEPLOY_API_KEY` | Required. The key for the application to deploy. |
| `ANTIDEPLOY_URL` | Optional. Defaults to `https://antideploy.com`. |

## What Antideploy does with what you send

Reads the source and works out the runtime, framework, build and start commands,
the port, and every environment variable the code references, deterministically,
citing the file each conclusion came from, not by asking a model to guess. Then
provisions what the app needs, including a Postgres database with `DATABASE_URL`
injected and migrations run *before* the app starts rather than after it has
already crashed. Then builds a container with buildpacks, releases it behind
HTTPS, and keeps it running: health checks, logs, and rollback to the last
version that went live (built again from its source, so it takes as long as a
deploy).

Full documentation: [antideploy.com/docs](https://antideploy.com/docs)

## License

MIT

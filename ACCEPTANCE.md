# Acceptance status, 0.2.0 release candidate

What has been checked, how, and what has not. Written 20 October 2026 and updated the same day after the first live runs and after 0.2.0 was published to npm and the MCP Registry.

Statuses are **Verified** (seen working, with the evidence named), **Failed**, or **Untested** (not run, with the reason). A check against the local stand-in server (`test/fake-antideploy.mjs`) proves the connector speaks the platform's documented contract. It does not prove the platform keeps that contract, so no live status below rests on it.

## Compatibility matrix

| Agent | Installation method | Authentication | Deployment | Logs | Update | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.280 | **Verified**: plugin from a local marketplace in an isolated config; bundled server completes the MCP handshake. The live runs below used `--mcp-config` with the bundle, not the plugin install. **Verified from GitHub** after `main` was fast-forwarded to 0.2.0 on 20 Oct: `claude plugin marketplace add antideploy/antideploy-mcp` and `claude plugin install antideploy@antideploy` in an isolated config installed version 0.2.0, enabled, and `claude mcp list` showed `npx -y antideploy-mcp@0.2.0` Connected. The published npm package lists 48 tools (cold 6.8 s) | **Verified live** with one Approve click. One extra message was needed, see "Findings" | **Verified live**: the agent created the application and deployed the Vite starter; it went live 2 min 41 s after the deploy call. In the first run the agent gave up early (finding 1); with the fix (run F) it finished | **Verified live** in run F: the agent read the logs after the deploy and reported the address and the account | **Verified live**: in run F an agent deployed over an existing application. The update itself was also checked by a direct call, and a second session **reused the saved login and the folder link** | Deploys, reads logs and reuses its login. One extra message after the Approve click. Found the silent name reuse in finding 7, now warned about in `f6094cc` |
| Cursor 2.6.20 | Untested: GUI only, and installing would change the real Cursor settings. Config and install link checked against Cursor's docs | Untested | Untested | Untested | Untested | Untested |
| OpenAI Codex | Untested: not installed on this machine. `config.toml` checked as valid TOML against Codex's docs | Untested | Untested | Untested | Untested | Untested |
| OpenCode | Untested: not installed on this machine. `opencode.json` checked against OpenCode's docs | Untested | Untested | Untested | Untested | Untested |

"Authentication" is the `login` tool against the real platform, which needs a person to click Approve. "Deployment", "Logs" and "Update" need a real deploy, which is the account owner's to trigger.

## What was verified

| Check | Result | Evidence |
| --- | --- | --- |
| The connector over stdio against the stand-in platform: login, application, database, deploy, status, logs, redeploy, rollback, variables, logout, and a revoked or declined login | Verified, source and bundle | `npm test`, `npm run test:bundle` |
| A project key still works, bound to its application, as before | Verified (stand-in) | `test/e2e.test.mjs`, "a project key, as before" |
| No token, device code or secret value appears in any tool result | Verified (stand-in), and the test fails when a leak is introduced | Mutation-tested |
| A folder is never matched to an application by guesswork | Verified (stand-in), and the test fails when guessing is introduced | Mutation-tested |
| Upload rules agree with the platform: 28 MB per file, a `.env` is never sent, Python virtualenvs skipped | Verified against the platform's source files | `test/units.test.mjs` compares the two when both repositories are checked out |
| `claude plugin validate` on the marketplace and the plugin folder | Verified: passes; four warnings, all the Anthropic-directory fields (`documentationUrl` and three more) that Claude Code before 2.1.281 does not know | Installed CLI |
| Installing the plugin from this repository as a marketplace | Verified in an isolated config: version 0.2.0, only the plugin folder is copied, no `node_modules` appears, no configuration prompt | Installed CLI |
| Claude Code's loader reads the plugin | Verified: 1 skill, 1 MCP server, about 291 tokens always on | `claude plugin details` |
| Claude Code starts the bundled server and completes the handshake | Verified | `claude mcp list` |
| The open skills installer finds the skill and lays it out for each agent | Verified from a local path: `.agents/skills/antideploy` (read by Cursor, Codex, OpenCode) and `.claude/skills/antideploy` | `npx skills add <path>` |
| Plugin-launched servers inherit the shell environment, so a project key needs no plugin setting | Verified | A probe plugin |
| First start from a clean machine | Measured: published 0.1.3 took 14.7 s cold and 3.7 s warm. The 0.2.0 bundle installs from its tarball in 2.3 s and answers in 0.2 s. After publishing, `npx -y antideploy-mcp@0.2.0` from the public registry with an empty npm cache reached a completed handshake and tool list in 6.8 s, and in 3.8 s with the cache warm (Windows, one run each) | Stopwatch runs |
| `antideploy-mcp@0.2.0` on public npm | Verified: the registry serves it (7 files, shasum `b10eb998aa4aa1643ebe82741570e3bce0b3b85f`, the one the dry run printed), `latest` is 0.2.0, and a clean `npx` start reports server version 0.2.0 with 48 tools, `login` and the `waitSeconds` option | `npm view`, the registry URL, a cold-cache handshake |
| `npx skills add antideploy/antideploy-mcp` from the public repository | Verified: `--list` finds the `antideploy` skill with the 787 character description | `skills` installer |
| The official MCP Registry | Verified: `com.antideploy/antideploy-mcp` 0.2.0 is active and marked latest | `registry.modelcontextprotocol.io/v0/servers` |
| The three starters build and run against a real Postgres | Verified locally: Vite build rendered in headless Chrome; Next.js built with no `DATABASE_URL`, then served, stored and listed notes; FastAPI did the same | Not deployed |
| Agent attribution report | Verified on a throwaway Postgres with the platform's real schema and 36 fixture checks | `test-agent-attribution.ts` in the platform repository, which is private |

## The seven scenarios, by entry point

A is the one-sentence prompt, B the installed skill, C the MCP tools. Only entry point C has been run live, by Claude Code, on 20 October 2026. A and B have not been run by any agent. Scenarios 2, 3 and 6 have not been run live.

| Scenario | A. Sentence | B. Skill | C. MCP |
| --- | --- | --- | --- |
| 1. Deploy a static Vite application | Untested | Untested | **Verified live** with Claude Code (the starter, 13 files; first deploy live in 2 min 41 s, and again in run F with 3 status calls) |
| 2. Deploy a Next.js application | Untested | Untested | Untested |
| 3. Deploy a backend with managed Postgres | Untested | Untested | Untested |
| 4. Retrieve deployment logs | Untested | Untested | **Verified live**: a direct call (real lines, health `healthy`) and an agent's own call in run F |
| 5. Update an existing application | Untested | Untested | Update **verified live** by a direct call (205 s, new page served), and an agent redeployed over an existing application in run F |
| 6. Diagnose a failed deployment | Untested | Untested | Untested |
| 7. Credentials are reused correctly | Untested | Untested | **Verified live**: a second Claude Code session, with no approval, saw the saved login and the folder's link to its application |

The projects for scenarios 1 to 3 are three small starters (Vite, Next.js with Postgres, FastAPI with Postgres) that live in a separate folder, `antideploy-starters`, outside this repository.

## Live runs, 20 October 2026

Platform: https://antideploy.com (production), on a dedicated test account that signs in with Google. Connector 0.2.0 from branch `release/0.2.0`, bundle `dist/antideploy-mcp.mjs`, with a throwaway home folder, so the login saved on the machine was never read. Agent: Claude Code 2.1.280, model `claude-sonnet-5-5` (the CLI printed `unrecognized_model` on stderr and ran regardless), started with `--tools ""` (no shell or file tools: only the 48 Antideploy tools), `--strict-mcp-config` and `--setting-sources project`. The project was a copy of the Vite starter.

| Run | What | Result | Cost |
| --- | --- | --- | --- |
| A | `scripts/live-check.mjs --deploy`, the connector alone | **Pass.** 0 failures, 1 manual step (the Approve click), 278 s in all. First live deploy 63 s, update 29 s, the live address served the change | none |
| B | Claude Code, `-p`, "Deploy this project on Antideploy." | Stopped at the approval link. The agent showed it and ended its turn. The connector process ended with the turn and forgot the pending code, so approving that code could not connect anything | 0.22 USD |
| C | Same prompt, streaming mode (one connector process for the whole session) | Nobody approved in time. The agent checked four times and stopped | 0.10 USD |
| D | Same, idling at no cost until the person said "approved" | Connected on the first check after the person's "continue". Created the application, deployed, and the app went live at https://project.antideploy.app after 2 min 41 s. The agent polled the status about 20 times in 40 s, spent 0.44 USD, and stopped at under two minutes, saying the build had been stuck "for many minutes" | 0.44 USD |
| E | A new Claude Code session, same project and home, "deploy it again" | `login` answered `connected` with no approval and named the application the folder is linked to. Stopped by its 0.20 USD cap after four turns, because a cold prompt cache cost 0.20 USD before the deploy call finished. No new deployment was made | 0.20 USD |
| F | After the fix, the same prompt in streaming mode with a fresh home (so a new login), idling until the person approved. The `ea46a92` bundle | **Pass.** Connected on the first check after the person's "continue". `create_application` linked the existing `project` application (finding 7); the agent checked its history, said so, and deployed over it. 3 `deployment_status` calls (each waiting up to 40 s, which the agent chose itself), live at https://project.antideploy.app 95 s after the deploy call (a redeploy of an app that was already built once), then it read the logs and told the user the address and the account. Manual steps: the Approve click and one message | 0.23 USD |

Claude Code spend: 1.19 USD (1.00 USD allowed, then 0.30 USD more for run F). Benchmark probe: 0.23 USD of 0.25 USD.

Checks made directly against the connector as the same login, which cost nothing (15 of 15 passed):

| Check | Result |
| --- | --- |
| `set_env_from_file` with a real name, a platform-managed name and an empty value | Stored the real one; refused `DATABASE_URL` with the reason; the value never appeared in any result |
| `list_env` | The name, no value |
| `deploy` with a `.env` in the folder | 13 files sent, the `.env` reported as not sent |
| Update: change the page, `deploy`, follow with the waiting `deployment_status` | Live after 205 s with 11 status calls; the live bundle served the change |
| A `directory` outside the project folder | Refused |
| `logs` from a folder that is not linked to an application | Refused, saying to call `create_application`; no guess |
| Account token with no application named | HTTP 400 |
| Account token naming an application that is not the account's | HTTP 404 |
| The same token naming its own application | HTTP 200 |
| An invalid token, and no token | HTTP 401 for both |

Not tested: a second account's token against this account's application (needs a second test account), and a project key (`ad_`) against account-level routes.

### Findings

1. **The agent polled in a tight loop** (run D). `deployment_status` answered at once, so the agent made about 20 calls in 40 s, spent 0.44 USD and gave up on a deploy that finished two minutes later. Fixed in `ea46a92`: one call now waits up to 20 s, `waitSeconds` can shorten or lengthen it (0 to 40), an unfinished answer says to call again, and the skill says not to pause or loop. Verified with the stand-in (a test that fails when the wait is removed) and, for the connector, live (205 s update, 11 calls). Run F confirms it: 3 status calls instead of about 20, and the deploy finished.
2. **A pending sign-in does not survive the connector process.** In `claude -p` the process ends with the turn, so a person who approves the link afterwards has approved a code nothing can redeem; the next run issues a new code. Interactive sessions keep the process, and the streaming run (D) connected normally. Saving the pending code to disk, with the same protection as the token, would close this. Not done: it is security-sensitive and needs its own review.
3. **One extra message was needed.** The agent shows the link and ends its turn; the person clicks Approve and says so. Manual steps for a first deploy: the click and one message.
4. **A cold start is expensive.** A session whose prompt cache is cold paid about 0.20 USD before doing anything; a warm one paid 0.03 USD per turn. Budget a first run at 0.25 USD or more.
5. **The starter's own instructions were followed.** Its `CLAUDE.md` says to build before deploying; the agent tried to, found it had no shell, and went on because the platform builds. This shows the harness limit more than a defect.
6. The agent in run D told the user the account it was connected to, and warned that it was not the address in its context. That is the behaviour the skill asks for.
7. **A name already in use was linked without a warning** (run F). `create_application` answered `reusedExisting: true` and told the agent to deploy next. The agent noticed, read the history of the application it had just been linked to, assumed it was the folder's own, and deployed over it. Here it was right (it was the earlier test app); with a folder named like a real app, it would have replaced a live site. `link_application` already says never to guess, so this was inconsistent. Fixed in `f6094cc`: the answer carries a `warning`, its next step is to ask the user before deploying, and the skill says the same. Verified with the stand-in (a test that fails without it); not re-run with an agent.

### To clean up (nothing was deleted automatically)

- Applications on the test account: `live-check-mvg87gia` (https://antideploy.com/app/d3a358b9-26e4-4df6-a510-681489ab85bc) and `project` (https://antideploy.com/app/48c9fe50-7d72-4cc6-bee1-a0e500e7e6d7). Delete them in the console.
- Logins: revoke the ones created today at https://antideploy.com/tokens.
- The temporary folders were removed from this machine.

## Running the live check

Local deploys share the production queue, so a live run is the account owner's to trigger, in a throwaway account or with a test application they are happy to delete.

**1. The connector, by itself, in thirty seconds.** This signs in and lists applications. It creates and deploys nothing.

```bash
npm run build
node scripts/live-check.mjs
```

**2. The whole lifecycle for the connector.** Creates one static application, deploys it, reads its logs and health, changes it and deploys again, then checks the live address. A static site counts against no plan limit. Delete the application in the console afterwards; the script prints the link.

```bash
node scripts/live-check.mjs --deploy
```

Either run uses a throwaway home directory, so it neither reads nor replaces the login saved on the machine. It writes `live-check-report.json` with the steps, timings, failures and the number of manual steps.

**3. Each agent, by hand.** In a clean folder holding a starter, with nothing about Antideploy installed, install by the guide for that agent, then say `Deploy this project on Antideploy.` Do this once per entry point (A: the sentence only; B: skill only; C: tools) and per agent. For each run record:

| Record | Why |
| --- | --- |
| Manual steps (target: one, the Approve click) | The central claim |
| Did login succeed on the first attempt | |
| Permission prompts or refusals from the agent, and at which tool | In earlier tests of the one-sentence flow, Claude Code's auto permission mode stopped the agent at the database call and at a check of the saved token file. With the tools, the agent itself reads no credentials file and runs no shell command (the connector does that inside its own process), which should help; this is untested |
| Tool calls that failed | |
| Seconds from the first message to a live address | |
| Final status and the address | |
| What the agent did after a failure, in scenario 6 (break the start command on purpose) | |

Then run scenarios 4 to 7 in the same session. Put each result in the matrix above with the date, the agent version, and the exact commands used.

## Not yet known

- Whether Claude Code, Codex, Cursor and OpenCode choose these tools and this skill for a deploy request on their own. A discovery benchmark, kept in a separate folder (`antideploy-benchmark`) outside this repository, measures that; no baseline has been run.
- Whether Cursor loads the plugin folder from a subdirectory of a repository, and whether its marketplace accepts that layout.
- Whether Anthropic's directory scan holds the pinned `npx` launcher for human review (its checklist says a pinned package is held). A hold is not a rejection.
- The first start time on a slower machine or network than this one (6.8 s cold here).

# Acceptance status, 0.2.0 release candidate

What has been checked, how, and what has not. Written 20 October 2026. Nothing here has been published.

Statuses are **Verified** (seen working, with the evidence named), **Failed**, or **Untested** (not run, with the reason). A check against the local stand-in server (`test/fake-antideploy.mjs`) proves the connector speaks the platform's documented contract. It does not prove the platform keeps that contract, so no live status below rests on it.

## Compatibility matrix

| Agent | Installation method | Authentication | Deployment | Logs | Update | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.280 | **Verified**: plugin from a local marketplace in an isolated config; bundled server completes the MCP handshake (`✔ Connected`). Untested from GitHub (not pushed) | Untested | Untested | Untested | Untested | Installs and starts. Live lifecycle not run |
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
| First start from a clean machine | Measured: published 0.1.3 took 14.7 s cold and 3.7 s warm. The 0.2.0 bundle installs from its tarball in 2.3 s and answers in 0.2 s. The 0.2.0 figure excludes the registry download of one 250 kB package, so re-measure with `npx -y antideploy-mcp@0.2.0` after publishing | Stopwatch runs |
| The three starters build and run against a real Postgres | Verified locally: Vite build rendered in headless Chrome; Next.js built with no `DATABASE_URL`, then served, stored and listed notes; FastAPI did the same | Not deployed |
| Agent attribution report | Verified on a throwaway Postgres with the platform's real schema and 36 fixture checks | `test-agent-attribution.ts` in the platform repository, which is private |

## The seven scenarios, by entry point

A is the one-sentence prompt, B the installed skill, C the MCP tools. No scenario has been run live. Entry point C's mechanics are covered against the stand-in; A and B have not been run by any agent.

| Scenario | A. Sentence | B. Skill | C. MCP |
| --- | --- | --- | --- |
| 1. Deploy a static Vite application | Untested | Untested | Untested |
| 2. Deploy a Next.js application | Untested | Untested | Untested |
| 3. Deploy a backend with managed Postgres | Untested | Untested | Untested |
| 4. Retrieve deployment logs | Untested | Untested | Untested |
| 5. Update an existing application | Untested | Untested | Untested |
| 6. Diagnose a failed deployment | Untested | Untested | Untested |
| 7. Credentials are reused correctly | Untested | Untested | Untested |

The projects for scenarios 1 to 3 are three small starters (Vite, Next.js with Postgres, FastAPI with Postgres) that live in a separate folder, `antideploy-starters`, outside this repository.

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
- The first start time of `npx -y antideploy-mcp@0.2.0` on a clean machine, after publishing.

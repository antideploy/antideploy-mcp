# When a deploy fails

Always start with `deployment_status` for the failed task: `error` (the explanation), `failedStep` (where it stopped), and the end of the build and runtime logs. Then `logs`. Fix the cause, then deploy again. The most common failure here is a project that builds correctly and never listens on its port, and redeploying it unchanged reproduces it exactly.

## The usual causes

| What you see | Cause | Fix |
| --- | --- | --- |
| Built fine, never became healthy | The app does not listen on the `PORT` it is given, or listens on `localhost` only | Read `PORT` from the environment and bind to `0.0.0.0` |
| A page loads but its scripts, styles or images are 404 | Only an entry file was sent | Send the whole project folder; `deploy` always does, so check `files` in its answer |
| "Missing variable" listed by the deploy | The code reads a variable nobody set | Store it with `set_env_from_file` or `request_keys`, then `redeploy`. For `NEON_AUTH_*`, `RESEND_*`, `DATABASE_URL`, `AWS_*`, call the matching `*_create` tool instead of asking the user |
| Works on a laptop, fails online | A `localhost` URL, a SQLite file, writes to local disk, or a dev-only variable | Use `DATABASE_URL`, a bucket for files, and the app's own address from the environment |
| `No buildpack groups passed detection` | The builder found no `package.json`, `requirements.txt`, `go.mod`, `Gemfile` or `pom.xml` at the root of what was sent | Send the folder that holds it, or set the root folder with `update_app_settings`, or add a Dockerfile |
| `npm error Missing script: build` | A step ran `npm run build` and `package.json` has no such script | Add a `build` script, or stop calling it |
| `invalid Node.js version specified` / `invalid Python version specified` | The project asks for a version the builder does not have; the message lists the ones it does | Pick one from the list: `engines.node` or `.nvmrc` for Node, `.python-version` for Python |
| A job or worker never runs | A timer or queue consumer inside the process; only the web process runs | Move the work into a route and call it with `add_schedule` |
| Out of memory | The app has 1 GB (a Java app has 2 GB) | Load large data lazily, not at startup |
| `too_large` (400) | A file or the folder is over the limit (28 MB; 4,000 files) | The answer names the files; remove or compress them, or have the app fetch them at runtime |

Each of these has a longer guide, titled with the exact message, in https://antideploy.com/blog.md. Search it for the error text.

## Things to check before assuming the platform is broken

- `health` is a reading from a sweep every five minutes. Compare its `checkedAt` with your deploy.
- The first request after the app has been idle takes seconds. That is the app waking, not a failure.

## When not to retry

| Answer | Meaning | What to do |
| --- | --- | --- |
| 402 `live_app_limit`, `deploy_month_limit`, `database_limit`, `storage_limit` | The plan's allowance is used | Tell the user. They can delete something in the console or change plan. Static sites never count |
| 403 `account_suspended` | The account is suspended | Tell the user. Waiting does not clear it |
| "Antideploy doesn't host ..." | The project matched a refused category | Remove that part of the project, or stop |
| 409 `deploy_in_progress` | One deploy at a time per app | Wait for the running one |
| 409 `own_database`, `own_storage`, `own_auth`, `own_email` | The project already uses its own service for that | Keep it; do not create ours |
| 429 `rate_limited` | Too many requests | Wait and try again, not in a loop |
| 503 `hosting_paused` | Deploys are paused platform-wide for a while | Retry after `retryAfterSeconds` |

## Tell the user

Say what failed in one sentence, what you changed, and the result. If you could not fix it, say what you tried and what you read.

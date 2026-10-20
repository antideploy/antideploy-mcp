# Examples

Each shows the user's words and what the agent does with the Antideploy tools. Without the MCP tools, the same steps are in https://antideploy.com/agent.md.

## A static site (Vite or plain HTML)

> "Put this site online."

1. `login`, show the link, wait for approval, `login` again.
2. `create_application` (name from the folder). Static sites never count against any plan limit.
3. `deploy`, then poll `deployment_status` until `succeeded`.
4. Tell the user the address and the account from `summary`.

## A Next.js app that needs a database

> "Build me a notes app with Next.js and deploy it."

1. `login`, then `create_application`.
2. `database_create` and `database_env_to_file`, before writing the data code. Build and test against that database.
3. Write the app. It reads `DATABASE_URL`. Do not set `DATABASE_URL` yourself anywhere else.
4. If it has sign-in, `auth_create` and `auth_env_to_file`.
5. `deploy`, poll, report the address and account.

## A FastAPI service with a secret from the user

> "Deploy this API. It calls Stripe."

1. `login`, `create_application`, `database_create` if it stores data.
2. `request_keys` with `["STRIPE_SECRET_KEY"]`. Show the user the link; they paste the key there. Poll `list_env` until the name appears. The key never enters the chat.
3. `deploy`, poll. If the status says a variable is missing, set it the same way, then `redeploy`.

## Something is wrong with a live app

> "The site is down."

1. `health`, then `deployment_history` (the last failure's sentence is in `error`) and `logs`.
2. If the last release broke it: `rollback`, and poll the returned `taskId`.
3. If it is a missing variable: `request_keys` or `set_env_from_file`, then `redeploy`.
4. Tell the user what you found, not only what you did.

## A change to an app that is already live

> "Change the heading and push it."

The folder already has `.antideploy.json`, so skip `create_application`. Make the change, `deploy`, poll. An unchanged folder answers `unchanged` and builds nothing.

## Using the app with a key in CI

For a pipeline, the user creates a project key for one application in the console and sets `ANTIDEPLOY_API_KEY`. The same tools then work without `login`, bound to that application.

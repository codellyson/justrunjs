# Deployment

The site (`/`), browser editor (`/web/`) and API (`/api/*`, `/auth/*`) are one Cloudflare
Worker: the Astro build is served as static assets and `marketing/worker/index.ts` handles
sign-in and saved work, backed by a D1 database. `.github/workflows/deploy-marketing.yml`
applies D1 migrations and deploys on every push to `master`.

## First-time setup

Run these from `marketing/`.

### 1. Create the D1 database

```sh
npx wrangler d1 create justrunjs
```

Copy the printed `database_id` into `wrangler.jsonc` (replacing the all-zero placeholder) and commit it.

### 2. Sign-in email sender

Sign-in codes are sent from `signin@justrunjs.kreativekorna.com` (`MAIL_FROM` in `wrangler.jsonc`)
through the Worker's `send_email` binding. `kreativekorna.com` must be onboarded to Cloudflare Email
Sending, as it is for Fillie; add the `justrunjs` subdomain sender there if the dashboard asks for it.

### 3. API token and GitHub secrets

Create a token at <https://dash.cloudflare.com/profile/api-tokens> with **Workers Scripts: Edit** and
**D1: Edit** on your account, then add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

### 4. Custom domain

After the first deploy, attach the domain under **Workers & Pages → justrunjs → Settings → Domains & Routes**.
If the domain still points at the old Pages project, remove it there first, then delete the Pages project.

## Local development

```sh
pnpm dev:api     # build, apply migrations to the local D1, run the Worker on :8797
pnpm dev         # astro dev on :4321, forwarding /api and /auth to :8797
pnpm test        # lesson engine
pnpm test:api    # API end to end against a local Worker (needs a build)
```

Sign-in emails are simulated locally: the code is printed in the `dev:api` output.

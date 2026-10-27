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

Copy the printed `database_id` into `wrangler.jsonc` and commit it. Done: `justrunjs` exists on the
Isiakalukmandellyson@gmail.com account (`fe217002-87b4-4c7d-b781-c5c5c1bfbfeb`).

### 2. Sign-in email sender

Sign-in codes are sent from `signin@crow.kreativekorna.com` (`MAIL_FROM` in `wrangler.jsonc`)
through the Worker's `send_email` binding. Turn on Email Sending for that domain, as Fillie does for its own:
`npx wrangler email sending enable crow.kreativekorna.com`.

### 3. API token and GitHub secrets

Create a token at <https://dash.cloudflare.com/profile/api-tokens> with **Workers Scripts: Edit** and
**D1: Edit** on your account, then add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

### 4. Custom domain

The site lives at `crow.kreativekorna.com`: `routes` in `wrangler.jsonc` attaches it as the Worker's custom
domain on deploy, and `site` in `astro.config.mjs` uses it for canonical and share-image URLs.
`kreativekorna.com` must be a zone on the same Cloudflare account as `CLOUDFLARE_ACCOUNT_ID`, and
`crow.kreativekorna.com` must not already have a DNS record, or the deploy fails.

## Local development

```sh
pnpm dev:api     # build, apply migrations to the local D1, run the Worker on :8797
pnpm dev         # astro dev on :4321, forwarding /api and /auth to :8797
pnpm test        # lesson engine
pnpm test:api    # API end to end against a local Worker (needs a build)
```

Sign-in emails are simulated locally: the code is printed in the `dev:api` output.

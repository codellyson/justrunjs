# Deployment

The marketing site (`/`) and browser editor (`/web/`) deploy to Cloudflare Pages
automatically on every push to `master`.

---

## Marketing site — first-time setup (Cloudflare Pages via GitHub Actions)

CI handles every deploy — no Cloudflare↔GitHub git integration needed.
The workflow lives in [`.github/workflows/deploy-marketing.yml`](.github/workflows/deploy-marketing.yml).

### 1. Create the CF Pages project (one-time)

The action deploys *into* an existing project, so the project name has to exist on Cloudflare first.

Either way works:

**Option A — Dashboard**: Cloudflare → Workers & Pages → Create application → Pages → **Direct upload** → name it `justrunjs`. Skip Git connection (this workflow is the deployer).

**Option B — Wrangler CLI** (one-line from your machine):
```sh
npx wrangler pages project create justrunjs --production-branch master
```

You'll be prompted to log in to Cloudflare in your browser the first time.

### 2. Create a CF API token

Go to <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Custom token** with:

- Permissions: **Account → Cloudflare Pages → Edit**
- Account resources: include your account

Copy the token (you only see it once).

### 3. Add GitHub Actions secrets

In the repo settings → Secrets and variables → Actions, add:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Your CF account ID (right sidebar of the CF dashboard) |

### 4. Push

The workflow triggers on any push to `master` that touches `marketing/**` (or on the workflow file itself). Every push to a non-master branch / every PR gets a preview deployment at a unique `*-justrunjs.pages.dev` URL — comment on the PR by the action.

### Custom domain

Once a deploy lands, hook up `justrunjs.com` (or whatever) under **Pages → justrunjs → Custom domains** in the CF dashboard. DNS for the domain has to be on Cloudflare for the one-click setup; otherwise add a CNAME manually pointing at `justrunjs.pages.dev`.

---

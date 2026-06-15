# runjs-rs marketing site

Astro + Tailwind static site for runjs-rs. Single-page landing for now; will
host the in-browser app at `/app` once `web/` lands.

## Develop

```sh
cd marketing
pnpm install
pnpm dev          # http://localhost:4321
```

## Build

```sh
pnpm build        # writes dist/
pnpm preview      # preview the built site
```

## Deploy to Cloudflare Pages

1. Push the repo to GitHub (already done — codellyson/runjs-rs).
2. In the Cloudflare dashboard, **Pages → Create project → Connect to Git**.
3. Pick the `runjs-rs` repo. Build settings:
   - **Framework preset:** Astro
   - **Build command:** `pnpm --filter runjs-rs-marketing build` (or
     simply `cd marketing && pnpm install && pnpm build` if you don't use
     pnpm workspaces yet — see note below)
   - **Build output directory:** `marketing/dist`
   - **Root directory:** leave at repo root
   - **Environment variables:** `NODE_VERSION=20`
4. Hit Save and Deploy.

Cloudflare will give you a `runjs-rs.pages.dev` URL. Custom domain wires
up under Pages → Settings → Custom domains.

> **Note:** This package is currently standalone (no root `pnpm-workspace.yaml`),
> so the simplest build command is:
>
> ```sh
> cd marketing && npm install && npm run build
> ```
>
> and set output dir to `marketing/dist`.

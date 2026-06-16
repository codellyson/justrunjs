# Deployment

Two surfaces:

| Surface | Where it lives | How releases happen |
|---|---|---|
| Marketing site (`/`) + browser editor (`/web/`) | Cloudflare Pages | Auto-deploy on every push to `master` |
| Desktop app | GitHub Releases | Tag push triggers cross-platform CI build + signed update bundle |

---

## Desktop app — first-time setup

The release pipeline lives in [`.github/workflows/release.yml`](.github/workflows/release.yml).
Three things need to happen once before the first release:

### 1. Generate a minisign signing keypair

This key signs every release bundle. The desktop app holds the **public** half (embedded in `tauri.conf.json`); CI holds the **private** half (in GitHub Actions secrets). Anyone with the private key can issue updates that your installed users will accept — so treat it like any other code-signing secret.

```sh
cargo tauri signer generate -w ~/.tauri/justrunjs.key
```

It'll prompt for a passphrase. Use one — a leaked key with no password is "anyone can ship malware as you" bad. Save the passphrase in your password manager.

Output:

- `~/.tauri/justrunjs.key` — the **private** key (encrypted with your passphrase). **Never commit this.**
- `~/.tauri/justrunjs.key.pub` — the **public** key (a one-line base64 blob).

### 2. Embed the public key in `tauri.conf.json`

Open `tauri.conf.json`, find `plugins.updater.pubkey`, and replace `REPLACE_WITH_MINISIGN_PUBKEY` with the contents of `~/.tauri/justrunjs.key.pub`:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/codellyson/justrunjs/releases/latest/download/latest.json"
    ],
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IF...="
  }
}
```

Commit and push. From this point forward, the desktop app will only accept updates signed by the matching private key.

### 3. Add the private key to GitHub Actions secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** on the GitHub repo, and add:

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The full contents of `~/.tauri/justrunjs.key` (paste it in — multi-line is fine) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The passphrase you set in step 1 |

`GITHUB_TOKEN` is auto-provided by Actions; you don't need to add it.

---

## Cutting a release

Once setup is done, releases are tag-triggered:

```sh
# 1. Bump versions in two places (keep them in sync):
#    - Cargo.toml: `version = "0.1.1"`
#    - tauri.conf.json: `"version": "0.1.1"`
# 2. Commit, tag, push:
git add Cargo.toml tauri.conf.json
git commit -m "Bump to v0.1.1"
git tag v0.1.1
git push origin master --tags
```

The push to `v*.*.*` fires `.github/workflows/release.yml`. About 20-30 minutes later you'll have a **draft** GitHub Release with:

- `justrunjs_0.1.1_aarch64.dmg` (macOS Apple Silicon)
- `justrunjs_0.1.1_x64.dmg` (macOS Intel)
- `justrunjs_0.1.1_x64_en-US.msi` (Windows)
- `justrunjs_0.1.1_amd64.deb` + `.AppImage` (Linux)
- `latest.json` (updater manifest — what installed apps poll for)
- Signed `.sig` files alongside each bundle

Review, edit the changelog notes, and click **Publish release**.

Once published, installed users get the update prompt on their next app launch.

---

## Marketing site — first-time setup (Cloudflare Pages)

This is dashboard-driven; no workflow file needed.

1. Go to **Cloudflare → Workers & Pages → Create application → Pages → Connect to Git**.
2. Authorize Cloudflare on the `codellyson/justrunjs` repository.
3. Build settings:

   | Setting | Value |
   |---|---|
   | Framework preset | Astro |
   | Build command | `cd marketing && pnpm install && pnpm build` |
   | Build output directory | `marketing/dist` |
   | Root directory | (leave blank) |
   | Environment variables | `NODE_VERSION = 20` |

4. Click **Save and Deploy**. First build takes ~3 minutes.

Cloudflare assigns `runjs-rs.pages.dev` automatically. Custom domain (e.g. `justrunjs.com`) wires up under **Pages → Settings → Custom domains** after you've configured DNS for the domain in Cloudflare.

Every push to `master` triggers a new deploy. PR builds get a preview URL.

---

## What users see when an update is ready

The Tauri updater plugin polls `endpoints[0]` on app launch (and once per hour while running). When it finds a `latest.json` with a higher version than the installed one, the app currently does nothing visible — there's no UI hooked up yet.

To make the prompt visible, add a small bit of frontend code that calls:

```js
const { check } = await import("@tauri-apps/plugin-updater");
const update = await check();
if (update?.available) {
  await update.downloadAndInstall();
}
```

We'll wire that into `main.js` (with a user-visible "Update available — Restart now" banner) once the first release has actually shipped and we've verified the signed-bundle flow end-to-end. Until then, users just need to grab the latest from the releases page manually.

import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://runjs-rs.pages.dev',
  integrations: [tailwind({ applyBaseStyles: false })],
  // `pnpm dev:api` runs the Worker on 8797; the dev server forwards the API to it.
  // The Worker refuses cross-site writes, so present the Worker's own origin.
  vite: {
    server: {
      proxy: Object.fromEntries(['/api', '/auth'].map((path) => [path, { target: 'http://localhost:8797', headers: { origin: 'http://localhost:8797' } }])),
    },
  },
});

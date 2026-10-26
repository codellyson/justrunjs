import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://runjs-rs.pages.dev',
  // `pnpm dev:api` runs the Worker on 8797; the dev server forwards the API to it.
  // The Worker refuses cross-site writes, so present the Worker's own origin.
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: Object.fromEntries(['/api', '/auth'].map((path) => [path, { target: 'http://localhost:8797', headers: { origin: 'http://localhost:8797' } }])),
    },
  },
});

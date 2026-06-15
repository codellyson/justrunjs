import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://runjs-rs.pages.dev',
  integrations: [tailwind({ applyBaseStyles: false })],
});

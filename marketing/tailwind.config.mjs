import justuiPreset from '@kreativekorna/justui/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [justuiPreset],
  content: [
    './src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}',
    './node_modules/@kreativekorna/justui/src/**/*.{astro,html,js,ts}',
  ],
};

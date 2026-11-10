import { defineConfig, type Plugin } from 'vite';

/** @fontsource の CSS から WOFF（旧形式）の指定を外し、WOFF2 だけを出力に含める */
function woff2Only(): Plugin {
  return {
    name: 'woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null;
      return code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '');
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [woff2Only()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});

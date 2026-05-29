// Minimal esbuild bundler for the VS Code extension host code.
// We bundle src/extension.ts into out/extension.js as a CommonJS module
// excluding "vscode" (provided by the host at runtime).

const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching…');
  } else {
    await esbuild.build(buildOptions);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

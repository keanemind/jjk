const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const isTest = process.argv.includes("--test");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  if (isTest) {
    // 1. Build the test launcher (runTest.ts)
    const launcherCtx = await esbuild.context({
      entryPoints: ["src/test/runTest.ts"],
      bundle: true,
      format: "cjs",
      platform: "node",
      outfile: "out/test/runTest.js",
      external: ["@vscode/test-electron"],
      logLevel: "silent",
      plugins: [esbuildProblemMatcherPlugin],
    });
    await launcherCtx.rebuild();
    await launcherCtx.dispose();
    console.log("Test launcher built: out/test/runTest.js");

    // 2. Build the actual test suite bundle (all-tests.ts)
    // This bundles all *.test.ts files (via imports in all-tests.ts)
    // and their src/ dependencies (like uri.ts and its dependency arktype).
    const allTestsBundleCtx = await esbuild.context({
      entryPoints: ["src/test/all-tests.ts"],
      bundle: true,
      format: "cjs",
      platform: "node", // Runs in VS Code extension host
      outfile: "out/test/all-tests.js",
      external: ["vscode", "mocha"],
      sourcemap: true,
      logLevel: "silent",
      plugins: [esbuildProblemMatcherPlugin],
    });
    await allTestsBundleCtx.rebuild();
    await allTestsBundleCtx.dispose();
    console.log("All tests bundle built: out/test/all-tests.js");

    // 3. Build the runner (runner.ts)
    // This script will load and run the all-tests.js bundle using Mocha.
    const suiteRunnerCtx = await esbuild.context({
      entryPoints: ["src/test/runner.ts"],
      bundle: true,
      format: "cjs",
      platform: "node", // Runs in VS Code extension host
      outfile: "out/test/runner.js",
      external: ["vscode", "mocha"],
      logLevel: "silent",
      plugins: [esbuildProblemMatcherPlugin],
    });
    await suiteRunnerCtx.rebuild();
    await suiteRunnerCtx.dispose();
    console.log("Test suite runner built: out/test/runner.js");
  } else {
    // Production/watch build for src/main.ts (extension code)
    const ctx = await esbuild.context({
      entryPoints: ["src/main.ts"],
      bundle: true,
      format: "cjs",
      minify: production,
      sourcemap: !production,
      sourcesContent: false,
      platform: "node",
      outfile: "dist/main.js",
      external: ["vscode"],
      logLevel: "silent",
      plugins: [esbuildProblemMatcherPlugin],
    });
    if (watch) {
      await ctx.watch();
    } else {
      await ctx.rebuild();
      await ctx.dispose();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

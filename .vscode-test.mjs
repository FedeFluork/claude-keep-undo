import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "integration",
  files: "out/test/integration/**/*.test.js",
  workspaceFolder: "./src/test/fixtures/workspace",
  mocha: {
    ui: "bdd",
    timeout: 60_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite runs the same on a laptop and in a CI job (test/setup-env.ts).
    setupFiles: ["test/setup-env.ts"],
    // Tests that run git and the CLI take over 5 s on a loaded machine.
    testTimeout: 30_000,
  },
});

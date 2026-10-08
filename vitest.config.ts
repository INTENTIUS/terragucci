import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite runs the same on a laptop and in a CI job (test/setup-env.ts).
    setupFiles: ["test/setup-env.ts"],
  },
});

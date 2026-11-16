import { defineConfig } from "vitest/config";

// chant's package exports list a "development" condition that points at src/, which chant
// stopped publishing in 0.124.99. Vite appends "development|production" to the resolve
// conditions of every non-production run, so take it out once the config is resolved and
// chant's imports land on the compiled dist/.
const withoutDevelopment = (conditions: string[] | undefined): void => {
  if (!conditions) return;
  for (let i = conditions.length - 1; i >= 0; i--) if (conditions[i] === "development|production") conditions.splice(i, 1);
};

export default defineConfig({
  plugins: [
    {
      name: "chant-dist-conditions",
      configResolved(config) {
        withoutDevelopment(config.resolve.conditions);
        withoutDevelopment(config.ssr.resolve?.conditions);
        for (const env of Object.values(config.environments ?? {})) withoutDevelopment(env.resolve?.conditions);
      },
    },
  ],
  test: {
    // The suite runs the same on a laptop and in a CI job (test/setup-env.ts).
    setupFiles: ["test/setup-env.ts"],
    // Tests that run git and the CLI take over 5 s on a loaded machine.
    testTimeout: 30_000,
  },
});

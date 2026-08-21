import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several suites spawn real `git` rather than mocking it, which is what
    // makes them worth having — but process spawning under parallel load is
    // far slower than the 5s default assumes, and the resulting timeouts hit
    // a different arbitrary subset of tests on every run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

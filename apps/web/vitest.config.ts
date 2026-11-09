import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Interface tests (*.test.tsx, @testing-library/react): the React 19 JSX runtime, as Next.js compiles it.
  esbuild: { jsx: "automatic" },
  test: {
    // Node by default; an interface test asks for a DOM with a `// @vitest-environment jsdom` first line.
    environment: "node",
    // prisma/: the pure modules of the seed and of the history script (pnpm db:history).
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "prisma/**/*.test.ts"],
    // The first Date / Intl / zod call of a worker can take several seconds on a
    // slow or antivirus-scanned machine: warm them up once, and allow slow tests.
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/mocks/server-only.ts")
    }
  },
  plugins: [
    {
      name: "yaml-raw",
      transform(code, id) {
        if (id.endsWith(".yml") || id.endsWith(".yaml")) {
          return { code: `export default ${JSON.stringify(code)}`, map: null };
        }
      }
    }
  ]
});

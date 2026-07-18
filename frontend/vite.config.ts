import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    cssMinify: "lightningcss",
    rollupOptions: {
      input: {
        home: "index.html",
        compiler: "compiler/index.html",
        experiment: "experiment/index.html",
        evidence: "evidence/index.html",
      },
    },
  },
});

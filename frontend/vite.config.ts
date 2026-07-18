import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Routes /runs/ and every /runs/<comparison-id>/ document request to the
 * single dashboard shell. The app validates the comparison ID itself and
 * renders a safe not-found state for unknown or unsafe IDs. A future S8-04
 * server can route any safe comparison ID to the same shell.
 */
function dashboardRunsShell(): Plugin {
  const rewrite = (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
    if (!req.url) {
      next();
      return;
    }
    const queryIndex = req.url.indexOf("?");
    const pathname = queryIndex === -1 ? req.url : req.url.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : req.url.slice(queryIndex);
    const isRunsList = pathname === "/runs" || pathname === "/runs/";
    const isRunsDocument = /^\/runs\/[^?]+$/.test(pathname) && !/\.[a-z0-9]+$/i.test(pathname);
    if ((isRunsList || isRunsDocument) && pathname !== "/runs/index.html") {
      req.url = `/runs/index.html${query}`;
    }
    next();
  };
  return {
    name: "camarade-dashboard-runs-shell",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [react(), dashboardRunsShell()],
  build: {
    target: "es2022",
    cssMinify: "lightningcss",
    rollupOptions: {
      input: {
        home: "index.html",
        compiler: "compiler/index.html",
        experiment: "experiment/index.html",
        evidence: "evidence/index.html",
        runs: "runs/index.html",
      },
    },
  },
});

/**
 * Static SPA build. The three disciplines that make the exported site work
 * from `file://` (and therefore from anywhere): relative base, hash routing,
 * and no fetches to absolute URLs.
 *
 * `publicDir` is deliberately false: `ui/dev-data/` must NOT ride into
 * `dist/` (every export would then ship stale fixture data). Dev serves it
 * through a middleware instead, mirroring the exported `data/` layout.
 */

import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const UI_ROOT = fileURLToPath(new URL(".", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
};

/** Serve ui/dev-data at /data during `vite dev` only. */
function devDataPlugin(): Plugin {
  const dataDir = join(UI_ROOT, "dev-data");
  return {
    name: "quickstudy-dev-data",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/data", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
        const filePath = join(dataDir, relative);
        // Path-traversal guard: the resolved path must stay inside dev-data.
        if (!filePath.startsWith(dataDir + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        const extension = filePath.slice(filePath.lastIndexOf("."));
        res.setHeader("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

/**
 * Inline the built JS + CSS into index.html. External `type="module"`
 * scripts are CORS-blocked from file:// pages (the data-index inlining alone
 * would still leave a blank page offline); INLINE module scripts execute
 * fine. Hand-rolled rather than a plugin dependency — ~30 lines, and the
 * spec's bundle-budget posture discourages casual deps.
 */
function inlineBundlePlugin(): Plugin {
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    name: "quickstudy-inline-bundle",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        let out = html;
        for (const [fileName, output] of Object.entries(bundle)) {
          const pattern = escapeRegExp(fileName);
          if (output.type === "chunk" && fileName.endsWith(".js")) {
            const tag = new RegExp(`<script type="module"[^>]*src="[^"]*${pattern}"[^>]*></script>`);
            if (!tag.test(out)) continue;
            // `</script` inside the JS would terminate the inline tag; escape it.
            const code = output.code.replace(/<\/script/g, "<\\/script");
            out = out.replace(tag, () => `<script type="module">${code}</script>`);
            delete bundle[fileName];
          } else if (output.type === "asset" && fileName.endsWith(".css")) {
            const tag = new RegExp(`<link[^>]*rel="stylesheet"[^>]*href="[^"]*${pattern}"[^>]*>`);
            if (!tag.test(out)) continue;
            out = out.replace(tag, () => `<style>${String(output.source)}</style>`);
            delete bundle[fileName];
          }
        }
        return out;
      },
    },
  };
}

export default defineConfig({
  root: UI_ROOT,
  base: "./",
  publicDir: false,
  plugins: [react(), devDataPlugin(), inlineBundlePlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
  },
});

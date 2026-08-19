/**
 * Static file server for exported sites — the serving half of
 * `quickstudy ui`. No server API, no routes: it serves exactly the bytes
 * `quickstudy export` writes, which is what keeps the two delivery modes
 * (file:// and served) one renderer.
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

export interface SiteServer {
  url: string;
  port: number;
  stop: () => void;
}

/**
 * Serve `dir` on localhost. Directory requests resolve to their index.html;
 * paths are traversal-guarded to the served root.
 */
export function serveSite(dir: string, port: number): SiteServer {
  const root = normalize(dir);
  const server = Bun.serve({
    port,
    fetch(request: Request): Response | Promise<Response> {
      const url = new URL(request.url);
      let relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
      let filePath = relative === "" ? root : join(root, relative);
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        return new Response("forbidden", { status: 403 });
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        return new Response("not found", { status: 404 });
      }
      // Re-read per request (no caching): `quickstudy ui --watch` re-exports
      // in place and the next request must see the fresh bytes.
      return new Response(Bun.file(filePath), {
        headers: { "Cache-Control": "no-store" },
      });
    },
  });
  // server.port is only undefined for unix-socket servers; this is TCP.
  const boundPort = server.port ?? port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    stop: () => server.stop(true),
  };
}

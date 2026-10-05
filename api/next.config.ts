import type { NextConfig } from "next"

/**
 * This Next app is the single deploy origin: the CRA bundle built by
 * `scripts/vercel-build.sh` lands in `public/`, and `/api/*` is served by the
 * route handlers under `app/api/`. Same origin means the app's `sameSite:
 * 'lax'` session/guest cookies stay first-party — a second Vercel project for
 * the UI would make them cross-site (vercel.app is on the public suffix list)
 * and break sign-in.
 *
 * SPA fallback: `frontend/src/App.js` only has two real routes, `/` and
 * `/settings`; everything else the app handles client-side with a `<Navigate
 * to="/">`. Next checks the filesystem first, so `/api/*` route handlers are
 * never shadowed by these rewrites — only paths that match no handler and no
 * file reach them.
 */
const nextConfig: NextConfig = {
  // tesseract.js spawns a worker from its own package layout — keep it
  // external so the bundler doesn't rewrite its worker/core paths (used by
  // `extractImage` in lib/sources.ts for OCR of uploaded photos).
  serverExternalPackages: ["tesseract.js", "or-tools-wasm"],
  // or-tools-wasm loads its CP-SAT runtime .wasm by path at solve time, so the
  // file tracer can't see it. Pin the CP-SAT runtime into every API function
  // (JSPI build for modern Node, asyncify fallback for older runtimes). Only
  // the CP-SAT runtime is included — not the other ~300 MB of solvers.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/or-tools-wasm/build/javascript/node-wasm/cp_sat_runtime_node.wasm",
      "./node_modules/or-tools-wasm/build/javascript/node-wasm/cp_sat_runtime_node_asyncify.wasm",
    ],
  },
  // The package ships every solver (routing/mathopt/mp_solver/pdlp/set_cover/
  // graph) plus a browser build — ~348 MB. We only use CP-SAT server-side, so
  // drop the rest from the traced function (CP-SAT node runtime ≈ 19 MB).
  outputFileTracingExcludes: {
    "/api/**": [
      "**/or-tools-wasm/build/javascript/wasm/**",
      "**/or-tools-wasm/build/javascript/browser/**",
      "**/or-tools-wasm/build/javascript/node-wasm/graph_*",
      "**/or-tools-wasm/build/javascript/node-wasm/mathopt_*",
      "**/or-tools-wasm/build/javascript/node-wasm/mp_solver_*",
      "**/or-tools-wasm/build/javascript/node-wasm/pdlp_*",
      "**/or-tools-wasm/build/javascript/node-wasm/routing_*",
      "**/or-tools-wasm/build/javascript/node-wasm/set_cover_*",
    ],
  },
  async headers() {
    return [
      {
        // matching all API routes
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
          { key: "Access-Control-Allow-Methods", value: "GET,DELETE,PATCH,POST,PUT" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version" },
        ]
      }
    ]
  },
  async rewrites() {
    return [
      { source: "/", destination: "/index.html" },
      { source: "/settings", destination: "/index.html" },
    ]
  },
}

export default nextConfig

/**
 * PictoQR Cleanup Worker
 *
 * Calls POST /api/cleanup on the Railway backend to delete expired R2 files.
 *
 * Environment variables (set via wrangler secret / wrangler deploy --var):
 *   RAILWAY_URL    — e.g. https://pictoqr-production.up.railway.app
 *   CLEANUP_SECRET — must match CLEANUP_SECRET set on Railway
 *
 * Routes:
 *   GET /           — health check
 *   GET /run-cleanup — triggers cleanup immediately (for manual testing)
 *
 * Cron: runs daily at 03:00 UTC (configured in wrangler.toml)
 */

export default {
  // HTTP fetch handler — lets you trigger cleanup manually via GET /run-cleanup
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/run-cleanup") {
      const result = await runCleanup(env);
      return result;
    }

    return new Response(
      JSON.stringify({ status: "ok", worker: "pictoqr-cleanup" }),
      { headers: { "Content-Type": "application/json" } }
    );
  },

  // Scheduled handler — triggered by cron in wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
};

async function runCleanup(env) {
  if (!env.RAILWAY_URL || !env.CLEANUP_SECRET) {
    return new Response(
      JSON.stringify({ error: "RAILWAY_URL and CLEANUP_SECRET must be set" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(`${env.RAILWAY_URL}/api/cleanup`, {
      method: "POST",
      headers: {
        "x-cleanup-secret": env.CLEANUP_SECRET,
        "Content-Type": "application/json",
      },
    });

    const body = await res.json();

    return new Response(JSON.stringify(body), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to reach Railway backend", detail: err.message }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}

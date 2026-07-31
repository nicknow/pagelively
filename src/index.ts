/**
 * pagelively Worker — Phase 0 stub.
 *
 * The real surface (public serving, admin UI, admin API) is built in later
 * slices. This stub exists so the toolchain — Worker runtime, TypeScript,
 * R2/D1 binding emulation, migrations-in-tests — is provably wired end-to-end
 * from the first commit. See docs/product-spec.md for the target behavior.
 */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Liveness check (spec §5). Bindings are emulated locally; the booleans
      // confirm the wiring reached the Worker.
      return Response.json({
        ok: true,
        service: "pagelively",
        siteName: env.SITE_NAME,
        bindings: { d1: !!env.DB, r2: !!env.BUCKET },
      });
    }

    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pagelively</title></head>' +
        "<body><h1>Pagelively</h1><p>Local scaffold — serving from <code>workerd</code>.</p></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler<Env>;

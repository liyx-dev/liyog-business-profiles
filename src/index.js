export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/b/")) {
      const slug = url.pathname.split("/")[2];

      if (!slug) {
        return new Response("Missing profile slug", { status: 400 });
      }

      const { results } = await env.DB.prepare(
        "SELECT * FROM profiles WHERE slug = ? AND is_active = 1"
      ).bind(slug).all();

      if (results.length === 0) {
        return new Response(
          JSON.stringify({ found: false, slug }),
          { headers: { "content-type": "application/json" }, status: 404 }
        );
      }

      const profile = results[0];

      if (profile.moderation_status !== "approved") {
        return new Response(
          JSON.stringify({ found: true, status: "pending_review", slug }),
          { headers: { "content-type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ found: true, profile }),
        { headers: { "content-type": "application/json" } }
      );
    }

    return new Response("Not a profile route", { status: 404 });
  }
};

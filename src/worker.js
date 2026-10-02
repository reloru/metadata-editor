// Serves the static assets in public/ and adds security headers to every response.

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'none'; img-src 'self' blob: data:; media-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};

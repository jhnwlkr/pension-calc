/**
 * Cloudflare Worker — POST /api/calc-event
 *
 * Records a Calculate button click to KV.
 *   calc:<clientId>:count  — total lifetime click count
 *   calc:<clientId>:last   — ISO timestamp of most recent click
 *   calc:total             — global total across all clients
 *
 * KV binding: CALC_EVENTS
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/api/calc-event') {
      return new Response(null, { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response(null, { status: 405 });
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return new Response(null, { status: 400 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    const clientId = typeof body.clientId === 'string' && body.clientId.length <= 64
      ? body.clientId.replace(/[^a-zA-Z0-9\-]/g, '')
      : null;

    if (!clientId) {
      return new Response(null, { status: 400 });
    }

    const kv = env.CALC_EVENTS;
    if (!kv) {
      return new Response(null, { status: 204 });
    }

    const countKey = `calc:${clientId}:count`;
    const lastKey  = `calc:${clientId}:last`;
    const totalKey = 'calc:total';

    const [rawCount, rawTotal] = await Promise.all([
      kv.get(countKey),
      kv.get(totalKey),
    ]);

    const newCount = (parseInt(rawCount || '0', 10) || 0) + 1;
    const newTotal = (parseInt(rawTotal || '0', 10) || 0) + 1;
    const now = new Date().toISOString();

    await Promise.all([
      kv.put(countKey, String(newCount)),
      kv.put(lastKey, now),
      kv.put(totalKey, String(newTotal)),
    ]);

    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  },
};

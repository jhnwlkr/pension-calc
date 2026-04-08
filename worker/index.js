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

    const country   = request.cf?.country || 'XX';
    const now       = new Date();
    const nowIso    = now.toISOString();
    const today     = nowIso.slice(0, 10); // YYYY-MM-DD

    const countKey      = `calc:${clientId}:count`;
    const lastKey       = `calc:${clientId}:last`;
    const countryKey    = `calc:${clientId}:country`;
    const daysKey       = `calc:${clientId}:days`;
    const lastDayKey    = `calc:${clientId}:lastDay`;
    const totalKey      = 'calc:total';
    const countryTotKey = `calc:country:${country}`;

    const [rawCount, rawTotal, rawCountryTot, rawLastDay, rawDays] = await Promise.all([
      kv.get(countKey),
      kv.get(totalKey),
      kv.get(countryTotKey),
      kv.get(lastDayKey),
      kv.get(daysKey),
    ]);

    const newCount      = (parseInt(rawCount      || '0', 10) || 0) + 1;
    const newTotal      = (parseInt(rawTotal      || '0', 10) || 0) + 1;
    const newCountryTot = (parseInt(rawCountryTot || '0', 10) || 0) + 1;
    const isNewDay      = rawLastDay !== today;
    const newDays       = (parseInt(rawDays || '0', 10) || 0) + (isNewDay ? 1 : 0);

    const writes = [
      kv.put(countKey,      String(newCount)),
      kv.put(lastKey,       nowIso),
      kv.put(totalKey,      String(newTotal)),
      kv.put(countryTotKey, String(newCountryTot)),
      kv.put(countryKey,    country),
      kv.put(daysKey,       String(newDays)),
    ];
    if (isNewDay) writes.push(kv.put(lastDayKey, today));

    await Promise.all(writes);

    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  },
};

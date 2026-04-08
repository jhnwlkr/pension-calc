/**
 * Cloudflare Pages Function — POST /api/calc-event
 *
 * Records a Calculate button click to KV.
 * Stores two keys per clientId:
 *   calc:<clientId>:count  — total lifetime click count (string integer)
 *   calc:<clientId>:last   — ISO timestamp of most recent click
 * Also maintains a global total counter at key "calc:total".
 *
 * KV binding required: CALC_EVENTS (add in Pages project settings → Functions → KV bindings)
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  // Only accept JSON
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return new Response('Bad Request', { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const clientId = typeof body.clientId === 'string' && body.clientId.length <= 64
    ? body.clientId.replace(/[^a-zA-Z0-9\-]/g, '')
    : null;

  if (!clientId) {
    return new Response('Bad Request', { status: 400 });
  }

  // Increment per-client count
  const countKey = `calc:${clientId}:count`;
  const lastKey  = `calc:${clientId}:last`;
  const totalKey = 'calc:total';

  const kv = env.CALC_EVENTS;
  if (!kv) {
    // KV not configured — fail silently so the app still works
    return new Response(null, { status: 204 });
  }

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

  return new Response(null, { status: 204 });
}

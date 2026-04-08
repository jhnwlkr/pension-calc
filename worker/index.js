/**
 * Cloudflare Worker — POST /api/calc-event
 *
 * Writes one data point to Analytics Engine per Calculate click.
 * Fields stored per event:
 *   indexes[0] = clientId   (for per-user filtering)
 *   blobs[0]   = clientId
 *   blobs[1]   = country    (ISO code from Cloudflare, e.g. "GB")
 *
 * Useful SQL queries (via CF Analytics Engine SQL API):
 *   Total clicks:          SELECT SUM(_sample_interval) FROM calc_events
 *   Clicks by country:     SELECT blob2 AS country, SUM(_sample_interval) AS clicks FROM calc_events GROUP BY country ORDER BY clicks DESC
 *   Unique users:          SELECT COUNT(DISTINCT blob1) FROM calc_events
 *   Clicks per user:       SELECT blob1, SUM(_sample_interval) AS clicks FROM calc_events GROUP BY blob1 ORDER BY clicks DESC
 *   Return users (days):   SELECT blob1, COUNT(DISTINCT toStartOfDay(timestamp)) AS days FROM calc_events GROUP BY blob1 ORDER BY days DESC
 *   Last 7 days:           add WHERE timestamp > NOW() - INTERVAL '7' DAY to any query
 *
 * Analytics Engine binding: ANALYTICS (dataset: calc_events)
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

    if (!env.ANALYTICS) {
      return new Response(null, { status: 204 });
    }

    const country = request.cf?.country || 'XX';

    env.ANALYTICS.writeDataPoint({
      indexes: [clientId],
      blobs:   [clientId, country],
    });

    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  },
};

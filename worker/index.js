/**
 * Cloudflare Worker — POST /api/calc-event
 *
 * Writes one data point to Analytics Engine per Calculate click.
 * Fields stored per event:
 *   indexes[0] = clientId    (for per-user filtering)
 *   blobs[0]   = clientId
 *   blobs[1]   = country     (ISO code from Cloudflare, e.g. "GB")
 *   blobs[2]   = device      ("mobile" or "desktop")
 *   blobs[3]   = referrer    (hostname or "direct")
 *   blobs[4]   = activeTab   (tab active at time of click)
 *   blobs[5]   = tabsVisited (comma-separated list of tabs visited this session)
 *
 * Useful SQL queries (via CF Analytics Engine SQL API):
 *   Total clicks:          SELECT SUM(_sample_interval) FROM calc_events
 *   Clicks by country:     SELECT blob2 AS country, SUM(_sample_interval) AS clicks FROM calc_events GROUP BY country ORDER BY clicks DESC
 *   Unique users:          SELECT COUNT(DISTINCT blob1) FROM calc_events
 *   By device:             SELECT blob3 AS device, SUM(_sample_interval) AS clicks FROM calc_events GROUP BY device
 *   By referrer:           SELECT blob4 AS referrer, SUM(_sample_interval) AS clicks FROM calc_events GROUP BY referrer ORDER BY clicks DESC
 *   By active tab:         SELECT blob5 AS tab, SUM(_sample_interval) AS clicks FROM calc_events GROUP BY tab ORDER BY clicks DESC
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

    const clientId    = typeof body.clientId === 'string' && body.clientId.length <= 64
      ? body.clientId.replace(/[^a-zA-Z0-9\-]/g, '')
      : null;
    const device      = ['mobile','desktop'].includes(body.device) ? body.device : 'unknown';
    const referrer    = typeof body.referrer === 'string' ? body.referrer.slice(0, 100).replace(/[^a-zA-Z0-9.\-]/g, '') : 'unknown';
    const activeTab   = typeof body.activeTab === 'string' ? body.activeTab.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '') : 'unknown';
    const tabsVisited = typeof body.tabsVisited === 'string' ? body.tabsVisited.slice(0, 200).replace(/[^a-zA-Z0-9,]/g, '') : '';

    if (!clientId) {
      return new Response(null, { status: 400 });
    }

    if (!env.ANALYTICS) {
      return new Response(null, { status: 204 });
    }

    const country = request.cf?.country || 'XX';

    env.ANALYTICS.writeDataPoint({
      indexes: [clientId],
      blobs:   [clientId, country, device, referrer, activeTab, tabsVisited],
    });

    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  },
};

#!/bin/zsh
# Analytics Engine query tool for retirecalc.uk
# Usage: ./query.sh [command]
# Commands: total, countries, users, returning, today, week, month
# Default (no argument): shows all summaries

ACCOUNT="bdedf0872e3d2938693f73171a53fcf7"
TOKEN=$(grep -o 'oauth_token = "[^"]*"' ~/Library/Preferences/.wrangler/config/default.toml | grep -o '"[^"]*"$' | tr -d '"')

if [[ -z "$TOKEN" ]]; then
  echo "Error: could not read wrangler OAuth token. Run 'npx wrangler login' first."
  exit 1
fi

query() {
  curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/analytics_engine/sql" \
    -H "Authorization: Bearer $TOKEN" \
    --data "$1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success', True) or 'errors' in d and d['errors']:
    print('Error:', d.get('errors', d))
    sys.exit(1)
rows = d.get('data', [])
if not rows:
    print('(no data yet)')
    sys.exit(0)
cols = list(rows[0].keys())
widths = [max(len(c), max((len(str(r[c])) for r in rows), default=0)) for c in cols]
fmt = '  '.join(f'{{:<{w}}}' for w in widths)
print(fmt.format(*cols))
print('  '.join('-' * w for w in widths))
for r in rows:
    print(fmt.format(*[str(r[c]) for c in cols]))
print(f'({len(rows)} row(s))')
"
}

DATASET="calc_events"

case "${1:-all}" in

  total)
    echo "=== Total Calculate clicks ==="
    query "SELECT SUM(_sample_interval) AS total_clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET"
    ;;

  countries)
    echo "=== Clicks by country ==="
    query "SELECT blob2 AS country, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET GROUP BY country ORDER BY clicks DESC"
    ;;

  users)
    echo "=== Top users by click count ==="
    query "SELECT blob1 AS client_id, SUM(_sample_interval) AS clicks, blob2 AS country FROM $DATASET GROUP BY client_id, country ORDER BY clicks DESC LIMIT 50"
    ;;

  returning)
    echo "=== Returning users (>1 day) ==="
    query "SELECT blob1 AS client_id, COUNT(DISTINCT toStartOfDay(timestamp)) AS active_days, SUM(_sample_interval) AS total_clicks FROM $DATASET GROUP BY client_id HAVING active_days > 1 ORDER BY active_days DESC"
    ;;

  today)
    echo "=== Today's activity ==="
    query "SELECT SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '1' DAY"
    ;;

  week)
    echo "=== Last 7 days ==="
    query "SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY day ORDER BY day DESC"
    ;;

  month)
    echo "=== Last 30 days ==="
    query "SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day DESC"
    ;;

  all)
    echo "=============================="
    echo " retirecalc.uk Analytics"
    echo "=============================="
    echo ""
    echo "=== Totals ==="
    query "SELECT SUM(_sample_interval) AS total_clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET"
    echo ""
    echo "=== Clicks by country ==="
    query "SELECT blob2 AS country, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET GROUP BY country ORDER BY clicks DESC"
    echo ""
    echo "=== Last 7 days (daily) ==="
    query "SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY day ORDER BY day DESC"
    echo ""
    echo "=== Returning users (>1 active day) ==="
    query "SELECT COUNT(DISTINCT blob1) AS returning_users FROM $DATASET WHERE blob1 IN (SELECT blob1 FROM $DATASET GROUP BY blob1 HAVING COUNT(DISTINCT toStartOfDay(timestamp)) > 1)"
    ;;

  *)
    echo "Usage: $0 [total|countries|users|returning|today|week|month]"
    echo "       $0          (runs all summaries)"
    exit 1
    ;;
esac

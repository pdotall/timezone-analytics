require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Your Cloudflare Worker that forwards to api.sim.dune.com and adds X-API-Key
const SIM_PROXY_URL = process.env.SIM_PROXY_URL; // e.g. https://smart-money.pdotcapital.workers.dev/v1
if (!SIM_PROXY_URL) throw new Error('SIM_PROXY_URL environment variable not set');

// Comma-separated chain IDs to include (default: ETH, Polygon, Base, Optimism, Arbitrum)
const SIM_CHAIN_IDS = (process.env.SIM_CHAIN_IDS || '1,137,8453,10,42161')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ACTIVITY_LIMIT = parseInt(process.env.SIM_ACTIVITY_LIMIT || '1000', 10); // per address per chain
const WORKERS = parseInt(process.env.WORKERS || '5', 10); // concurrent fetchers

app.use(cors({ origin: true }));     // allow cross-origin (useful during dev)
app.use(express.json());

// trust the first proxy (Codespaces/Cloudflare/Nginx/etc.)
app.set('trust proxy', 1);


// basic rate limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
app.use(limiter);

// simple in-memory cache
const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

// ----------------- helpers -----------------
const tzExamples = {
  '-12': 'Etc/GMT+12',  '-11': 'Pacific/Pago_Pago',    '-10': 'Pacific/Honolulu',
  '-9':  'America/Anchorage','-8': 'America/Los_Angeles','-7': 'America/Denver',
  '-6':  'America/Chicago','-5': 'America/New_York',   '-4': 'America/Halifax',
  '-3':  'America/Sao_Paulo','-2': 'Atlantic/South_Georgia','-1': 'Atlantic/Azores',
  '0':   'Etc/UTC','1': 'Europe/Berlin','2': 'Europe/Kaliningrad','3': 'Europe/Moscow',
  '4':   'Asia/Dubai','5': 'Asia/Karachi','6': 'Asia/Dhaka','7': 'Asia/Bangkok',
  '8':   'Asia/Shanghai','9': 'Asia/Tokyo','10': 'Australia/Sydney','11': 'Pacific/Noumea',
  '12':  'Pacific/Auckland','13': 'Pacific/Tongatapu','14': 'Pacific/Kiritimati',
};
const exampleTz = (offset) => tzExamples[String(offset)] || 'Etc/UTC';

function analyzeHourlyCounts(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offset = -12; offset <= 14; offset++) {
    let daySum = 0;
    for (let i = 0; i < 24; i++) {
      const localHour = (i + offset + 24) % 24;
      if (localHour >= 8 && localHour < 18) daySum += counts[i];
    }
    if (daySum > bestScore) {
      bestScore = daySum;
      bestOffset = offset;
    }
  }
  const utc_label = `UTC${bestOffset >= 0 ? '+' : ''}${bestOffset}`;
  const ratio = total ? bestScore / total : 0;
  const highBars = counts.filter((c) => c >= median * 3).length;
  const passes_rule = ratio > 0.5 && highBars >= 3;
  return {
    utc_offset_hours: bestOffset,
    utc_label,
    iana_tz_example: exampleTz(bestOffset),
    median,
    ratio,
    bars_high_over_mult: highBars,
    passes_rule,
  };
}

// Turn a SIM /evm/activity page into hour buckets (UTC)
function accumulateHoursFromActivity(counts24, activity, filterAddrLower) {
  for (const ev of activity || []) {
    try {
      const ts = Date.parse(ev.block_time);
      if (!Number.isFinite(ts)) continue;
      if (filterAddrLower && ev.wallet_address && ev.wallet_address.toLowerCase() !== filterAddrLower) continue;
      const hourUtc = new Date(ts).getUTCHours();
      counts24[hourUtc] = (counts24[hourUtc] || 0) + 1;
    } catch {}
  }
  return counts24;
}

// Fetch one address across all configured chains and build its 24-hour UTC histogram
async function fetchAddressHistogramSIM(address) {
  const addrLower = address.toLowerCase();
  const counts = new Array(24).fill(0);

  const queue = [...SIM_CHAIN_IDS];
  const workers = Array.from({ length: WORKERS }, async () => {
    while (queue.length) {
      const chainId = queue.pop();
      const url = `${SIM_PROXY_URL}/evm/activity/${addrLower}`
        + `?chain_ids=${encodeURIComponent(chainId)}`
        + `&type=send,receive,mint,burn,swap,transfer`
        + `&limit=${ACTIVITY_LIMIT}`
        + `&sort_by=block_time&sort_order=asc`;

      try {
        const r = await axios.get(url, { timeout: 25_000 });
        const activity = r.data?.activity || [];
        accumulateHoursFromActivity(counts, activity, addrLower);
      } catch (e) {
        // non-fatal; continue
      }
    }
  });
  await Promise.all(workers);
  return counts;
}

// ----------------- API -----------------
app.post('/api/timezone', async (req, res) => {
  try {
    const { addresses } = req.body || {};
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses array required' });
    }

    const cacheKey = addresses.map((a) => String(a).toLowerCase()).sort().join(',');
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const queue = [...addresses.map(String)];
    const results = [];
    const workerCount = Math.min(WORKERS, Math.max(1, Math.ceil(addresses.length / 2)));

    async function worker() {
      while (queue.length) {
        const address = queue.pop();
        const counts = await fetchAddressHistogramSIM(address);
        results.push({ address, ...analyzeHourlyCounts(counts) });
      }
    }
    await Promise.all(Array.from({ length: workerCount }, worker));

    cache.set(cacheKey, results);
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to infer timezones from SIM' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

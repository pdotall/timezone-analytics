require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3001;
const DUNE_PROXY_URL = process.env.DUNE_PROXY_URL;

if (!DUNE_PROXY_URL) {
  throw new Error('DUNE_PROXY_URL environment variable not set');
}

app.use(express.json());

// basic rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
});
app.use(limiter);

// simple in-memory cache
const cache = new NodeCache({ stdTTL: 300 }); // cache for 5 minutes

const tzExamples = {
  '-12': 'Etc/GMT+12',
  '-11': 'Pacific/Pago_Pago',
  '-10': 'Pacific/Honolulu',
  '-9': 'America/Anchorage',
  '-8': 'America/Los_Angeles',
  '-7': 'America/Denver',
  '-6': 'America/Chicago',
  '-5': 'America/New_York',
  '-4': 'America/Halifax',
  '-3': 'America/Sao_Paulo',
  '-2': 'Atlantic/South_Georgia',
  '-1': 'Atlantic/Azores',
  '0': 'Etc/UTC',
  '1': 'Europe/Berlin',
  '2': 'Europe/Kaliningrad',
  '3': 'Europe/Moscow',
  '4': 'Asia/Dubai',
  '5': 'Asia/Karachi',
  '6': 'Asia/Dhaka',
  '7': 'Asia/Bangkok',
  '8': 'Asia/Shanghai',
  '9': 'Asia/Tokyo',
  '10': 'Australia/Sydney',
  '11': 'Pacific/Noumea',
  '12': 'Pacific/Auckland',
  '13': 'Pacific/Tongatapu',
  '14': 'Pacific/Kiritimati',
};

function exampleTz(offset) {
  return tzExamples[String(offset)] || 'Etc/UTC';
}

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
  const bars_high_over_mult = highBars;
  const passes_rule = ratio > 0.5 && highBars >= 3;
  return {
    utc_offset_hours: bestOffset,
    utc_label,
    iana_tz_example: exampleTz(bestOffset),
    median,
    ratio,
    bars_high_over_mult,
    passes_rule,
  };
}

app.post('/api/timezone', async (req, res) => {
  try {
    const { addresses } = req.body || {};
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses array required' });
    }

    const cacheKey = addresses.slice().sort().join(',');
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const response = await axios.post(DUNE_PROXY_URL, { addresses });
    const rows = response.data?.result || [];

    const grouped = {};
    for (const row of rows) {
      const addr = row.address;
      if (!grouped[addr]) grouped[addr] = new Array(24).fill(0);
      const h = row.hour_utc;
      grouped[addr][h] = row.tx_count;
    }

    const out = Object.entries(grouped).map(([address, counts]) => ({
      address,
      ...analyzeHourlyCounts(counts),
    }));

    cache.set(cacheKey, out);
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch timezone info' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});


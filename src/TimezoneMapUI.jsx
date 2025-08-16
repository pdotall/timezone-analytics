import React, { useEffect, useRef, useState } from 'react';

/**
 * Interactive UTC Timezones — React + Leaflet (no react-leaflet)
 * - Real IANA polygons from Timezone Boundary Builder (TzBB)
 * - Live UTC offsets via Intl.DateTimeFormat
 * - Fallback to Natural Earth TopoJSON, then to a tiny built-in polygon
 */

// ---------- Helpers ----------
const getZoneName = (props = {}) =>
  props.tzid || props.TZID || props.time_zone || props.NAME || props.name || 'Timezone';

const isEvm = (s) => /^(0x)[0-9a-fA-F]{40}$/.test(s);
const isSol = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); // rough base58
export const parseAddresses = (text) => {
  const parts = String(text || '')
    .split(/[\s,;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const uniq = Array.from(new Set(parts));
  return uniq.filter((a) => isEvm(a) || isSol(a));
};

const pastelFromLabel = (label) => {
  let h = 0;
  const s = String(label || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 85% 70%)`;
};

export const isFeatureCollection = (obj) =>
  !!obj && obj.type === 'FeatureCollection' && Array.isArray(obj.features);

const isNumber = (x) => typeof x === 'number' && Number.isFinite(x);
const isPosition = (p) => Array.isArray(p) && p.length >= 2 && isNumber(p[0]) && isNumber(p[1]);
const isLinearRing = (ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition);
const isPolygon = (coords) => Array.isArray(coords) && coords.length > 0 && coords.every(isLinearRing);
const isMultiPolygon = (coords) => Array.isArray(coords) && coords.length > 0 && coords.every(isPolygon);

export function sanitizeFeatureCollection(fcIn) {
  try {
    if (!isFeatureCollection(fcIn)) return null;
    const out = { type: 'FeatureCollection', features: [] };
    for (const feat of fcIn.features || []) {
      if (!feat || typeof feat !== 'object') continue;
      const g = feat.geometry;
      if (!g || typeof g !== 'object') continue;
      if (g.type === 'Polygon' && isPolygon(g.coordinates)) out.features.push(feat);
      else if (g.type === 'MultiPolygon' && isMultiPolygon(g.coordinates)) out.features.push(feat);
    }
    return out.features.length ? out : null;
  } catch {
    return null;
  }
}

// Toggle table rows with LIFO removal for same zone
export const toggleRowsLifo = (prevRows, zoneLabel, { addressCount, sample, source }) => {
  const idx = prevRows.findIndex((r) => r.zone === zoneLabel); // most recent at 0
  if (idx === 0) return { rows: prevRows.slice(1), toggledOff: true };
  if (idx > 0) return { rows: [...prevRows.slice(0, idx), ...prevRows.slice(idx + 1)], toggledOff: true };
  const ts = new Date().toISOString();
  return {
    rows: [{ ts, zone: zoneLabel, source: source || 'tzbb', address_count: addressCount || 0, sample: sample || '' }, ...prevRows],
    toggledOff: false,
  };
};

// Built-in tiny polygon fallback
const FALLBACK_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { tzid: 'UTC (fallback)' },
      geometry: { type: 'Polygon', coordinates: [[[-5, 45], [5, 45], [5, 35], [-5, 35], [-5, 45]]] },
    },
  ],
};

// Live offset label for an IANA tzid
function currentOffsetLabel(tzid, when = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzid, hour12: false, timeZoneName: 'shortOffset' });
    const parts = fmt.formatToParts(when);
    const off = parts.find((p) => p.type === 'timeZoneName')?.value || 'UTC±0';
    const m = off.match(/([UG]MT|UTC)\s*([+-]\d{1,2})(?::?(\d{2}))?/i);
    if (!m) return 'UTC±00:00';
    const hours = parseInt(m[2], 10);
    const sign = hours >= 0 ? '+' : '-';
    const h = String(Math.abs(hours)).padStart(2, '0');
    const mm = m[3] ? m[3] : '00';
    return `UTC${sign}${h}:${mm}`;
  } catch {
    return 'UTC±00:00';
  }
}

// ---------- Component ----------
export default function TimezoneMapUI() {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const tzLayerRef = useRef(null);

  const [selectedZones, setSelectedZones] = useState([]); // labels (tzid)
  const selectedZonesRef = useRef(selectedZones);
  useEffect(() => {
    selectedZonesRef.current = selectedZones;
  }, [selectedZones]);

  const [addresses, setAddresses] = useState([]);
  const [addressInput, setAddressInput] = useState('');
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  // 1) Preferred: TzBB (IANA) GeoJSON you host
  const TZBB_GEOJSON_URL = 'https://YOUR-HOST/path/timezones-now.geojson'; // <-- TODO: set me
  // 2) Fallback: Natural Earth TopoJSON (older, offset-based)
  const NE_TOPO_URL =
    'https://gist.githubusercontent.com/tschaub/cc70281ce4df5358eac38b34409b9ef9/raw/d152ba9e83d7733d9fb5f37f52202c0fcead834a/timezones.json';

  const [geoData, setGeoData] = useState(FALLBACK_FC);

  // Loader utilities
  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => {
        s.dataset.loaded = 'true';
        resolve();
      };
      s.onerror = reject;
      document.body.appendChild(s);
    });

  const loadCSS = (href) =>
    new Promise((resolve, reject) => {
      const existing = document.querySelector(`link[href="${href}"]`);
      if (existing) return resolve();
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = resolve;
      l.onerror = reject;
      document.head.appendChild(l);
    });

  // Map init
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
        await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
        if (cancelled) return;
        const L = window.L;
        if (!L) throw new Error('Leaflet failed to load');

        mapRef.current = L.map(mapEl.current, {
          minZoom: 1.5,
          worldCopyJump: true,
          zoomSnap: 0.25,
          zoomDelta: 0.25,
        }).setView([20, 0], 2.2);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          opacity: 0.5,
          attribution: '&copy; OSM',
        }).addTo(mapRef.current);

        // Load IANA polygons (TzBB). If it fails, fallback to Natural Earth.
        await loadZonesPreferTzbb();
        renderZones();

        mapRef.current.on('click', (e) => {
          if (!e.originalEvent.target.closest?.('.leaflet-interactive')) setSelectedZones([]);
        });
      } catch (err) {
        console.error(err);
        setStatus(err.message || String(err));
      }
    })();

    return () => {
      cancelled = true;
      try {
        mapRef.current?.remove();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Style updates on selection change
  useEffect(() => {
    if (!tzLayerRef.current) return;
    try {
      tzLayerRef.current.eachLayer((layer) => {
        const feature = layer.feature || {};
        const tzid = getZoneName(feature.properties || {});
        const selected = selectedZones.includes(tzid);
        const color = pastelFromLabel(tzid);
        layer.setStyle({
          fillColor: selected ? color : 'transparent',
          fillOpacity: selected ? 0.6 : 0,
          color: selected ? color : '#6072a6',
          weight: selected ? 2 : 1,
        });
        layer.bindTooltip(`${tzid} · ${currentOffsetLabel(tzid)}`, { sticky: true, direction: 'top' });
      });
    } catch {}
  }, [selectedZones]);

  // Re-render layer when data changes
  useEffect(() => {
    if (mapRef.current) renderZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoData]);

  // Load zones: try TzBB, else NE
  async function loadZonesPreferTzbb() {
    setLoading(true);
    try {
      // Try TzBB (already GeoJSON)
      if (TZBB_GEOJSON_URL && !TZBB_GEOJSON_URL.includes('YOUR-HOST')) {
        const r = await fetch(TZBB_GEOJSON_URL, { cache: 'reload' });
        if (!r.ok) throw new Error(`TzBB GeoJSON HTTP ${r.status}`);
        const fc = await r.json();
        const sanitized = sanitizeFeatureCollection(fc);
        if (!sanitized) throw new Error('TzBB data invalid FeatureCollection');
        setGeoData(sanitized);
        setStatus(`Loaded ${sanitized.features?.length ?? 0} IANA zones (live offsets).`);
        return;
      }
      throw new Error('TzBB URL not set');
    } catch (tzErr) {
      console.warn('TzBB load failed → fallback to Natural Earth', tzErr);
      try {
        await loadScript('https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js');
        const r = await fetch(NE_TOPO_URL, { cache: 'reload' });
        if (!r.ok) throw new Error(`Natural Earth TopoJSON HTTP ${r.status}`);
        const topo = await r.json();
        const objects = topo?.objects || {};
        const keys = Object.keys(objects);
        if (!keys.length) throw new Error('NE TopoJSON: no objects');
        const bestKey = keys.find((k) => /time/i.test(k)) || keys[0];
        const fc = window.topojson.feature(topo, objects[bestKey]);
        const sanitized = sanitizeFeatureCollection(fc);
        if (!sanitized) throw new Error('Converted NE data invalid FeatureCollection');
        setGeoData(sanitized);
        setStatus(`Loaded ${sanitized.features?.length ?? 0} (Natural Earth fallback). Offsets may be approximate.`);
      } catch (neErr) {
        console.error(neErr);
        setGeoData(FALLBACK_FC);
        setStatus(`All data loads failed — showing tiny fallback polygon.`);
      }
    } finally {
      setLoading(false);
    }
  }

  function renderZones() {
    const L = window.L;
    if (!L || !mapRef.current || !geoData) return;

    if (tzLayerRef.current) {
      try {
        tzLayerRef.current.remove();
      } catch {}
      tzLayerRef.current = null;
    }

    const style = (feature) => {
      const tzid = getZoneName(feature?.properties || {});
      const selected = selectedZonesRef.current.includes(tzid);
      const color = pastelFromLabel(tzid);
      return {
        color: selected ? color : '#6072a6',
        weight: selected ? 2 : 1,
        fillColor: selected ? color : 'transparent',
        fillOpacity: selected ? 0.6 : 0,
      };
    };

    const onEachFeature = (feature, layer) => {
      const tzid = getZoneName(feature?.properties || {});
      layer.bindTooltip(`${tzid} · ${currentOffsetLabel(tzid)}`, { sticky: true, direction: 'top' });
      layer.on('click', () => {
        setSelectedZones((prev) => {
          const already = prev.includes(tzid);
          setRows((prevRows) =>
            toggleRowsLifo(prevRows, tzid, {
              addressCount: addresses.length,
              sample: addresses.slice(0, 3).join(' | '),
              source: TZBB_GEOJSON_URL && !TZBB_GEOJSON_URL.includes('YOUR-HOST') ? 'tzbb' : 'ne',
            }).rows
          );
          return already ? prev.filter((z) => z !== tzid) : [tzid, ...prev];
        });
        try {
          if (layer.getBounds) mapRef.current.fitBounds(layer.getBounds(), { padding: [20, 20] });
        } catch {}
      });
    };

    tzLayerRef.current = L.geoJSON(geoData, { style, onEachFeature }).addTo(mapRef.current);
  }

  // ---------- UI ----------
  return (
    <div
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: 16,
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
        color: '#e8ecff',
      }}
    >
      <style>{`
        :root { --card: rgba(255,255,255,0.06); --stroke: rgba(255,255,255,0.12); --text: #e8ecff; --muted:#aab4d6; }
        .fancy-bg { position: fixed; inset: -20vmax; z-index: -1; background:
          radial-gradient(60vmax 60vmax at 20% 10%, #2b5cff22, transparent),
          radial-gradient(50vmax 50vmax at 80% 30%, #00ffd522, transparent),
          radial-gradient(40vmax 40vmax at 50% 90%, #ff66cc22, transparent);
          filter: blur(40px); animation: float 16s ease-in-out infinite alternate; }
        @keyframes float { from { transform: translateY(-8px);} to { transform: translateY(8px);} }
        .card { background: var(--card); border: 1px solid var(--stroke); border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0,0,0,.35); backdrop-filter: blur(8px); }
        .btn { border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; font-weight: 700;
          transition: transform .12s ease, box-shadow .2s ease; }
        .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(0,0,0,.25); }
        .btn-primary { background: linear-gradient(135deg,#5c7cfa,#4dabf7); color: white; }
        .btn-plain { background: #0b1020; color: var(--text); border: 1px solid var(--stroke); }
        .textarea { width: 100%; height: 140px; background: #081225; color: var(--text);
          border: 1px solid var(--stroke); border-radius: 12px; padding: 12px; }
        .pill { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px;
          border: 1px solid var(--stroke); background: rgba(255,255,255,.05); font-size:12px; }
        .pill button { background: transparent; border: 0; color: #ffffffcc; cursor: pointer; border-radius: 999px; padding: 0 6px; }
        .table { width: 100%; border-collapse: collapse; font-size: 13px; color: var(--text); }
        .th, .td { padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .thead { position: sticky; top: 0; background: #0f1424; z-index: 1; }
      `}</style>

      <div className="fancy-bg" />
      <h1 style={{ margin: 0, fontSize: 28, letterSpacing: 0.3 }}>
        <span
          style={{
            background: 'linear-gradient(135deg,#91a7ff,#63e6be)',
            WebkitBackgroundClip: 'text',
            color: 'transparent',
            fontWeight: 800,
          }}
        >
          UTC Timezones
        </span>
        <span style={{ fontSize: 13, color: '#b6c2ff', fontWeight: 600, opacity: 0.9, marginLeft: 10 }}>
          IANA polygons • live offsets
        </span>
      </h1>
      <p style={{ marginTop: 6, color: '#c7d0ff', opacity: 0.85 }}>
        Paste addresses, click a zone to log it, click again to undo the last log for that zone.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1.45fr .55fr', gap: 16, marginTop: 14 }}>
        {/* Map card */}
        <div className="card" style={{ padding: 14 }}>
          <div
            style={{
              marginBottom: 10,
              color: '#c9d2ff',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>Map</span>
            <span style={{ fontSize: 12, color: '#9fb0ff' }}>{loading ? 'Loading timezones…' : status}</span>
          </div>
          <div
            ref={mapEl}
            style={{ height: 560, borderRadius: 12, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
          />
          {selectedZones.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {selectedZones.map((z) => (
                <span key={z} className="pill">
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: pastelFromLabel(z),
                      boxShadow: '0 0 0 2px rgba(0,0,0,.25) inset',
                    }}
                  />
                  {z}
                  <button
                    title="Remove"
                    onClick={() => {
                      setSelectedZones((prev) => prev.filter((p) => p !== z));
                      setRows((prev) => toggleRowsLifo(prev, z, { addressCount: 0, sample: '', source: 'tzbb' }).rows);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Address card */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ marginBottom: 10, color: '#c9d2ff', fontWeight: 700 }}>Addresses</div>
          <textarea
            className="textarea"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            placeholder="Paste crypto addresses (EVM 0x..., Solana base58). One per line or separated by spaces/commas."
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button className="btn btn-primary" onClick={() => setAddresses(parseAddresses(addressInput))}>
              Parse
            </button>
            <span style={{ fontSize: 12, color: '#b9c3e6' }}>
              {addresses.length} valid address{addresses.length === 1 ? '' : 'es'}
            </span>
            <button
              className="btn btn-plain"
              onClick={() => {
                // quick local tests
                const results = [];
                try {
                  const parsed = parseAddresses(
                    '0x0000000000000000000000000000000000000000\njunk\n1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
                  );
                  results.push(['Parse EVM + Sol', parsed.length >= 2]);
                  const c1 = pastelFromLabel('UTC+1'),
                    c2 = pastelFromLabel('UTC+1'),
                    c3 = pastelFromLabel('UTC+2');
                  results.push(['Pastel stable', c1 === c2 && c1 !== c3]);
                  alert(results.map(([n, ok]) => `${n}: ${ok}`).join('\n'));
                } catch (e) {
                  alert('Tests threw: ' + (e.message || String(e)));
                }
              }}
              style={{ marginLeft: 'auto' }}
            >
              Run Tests
            </button>
          </div>
        </div>
      </div>

      {/* Table under the map */}
      <div className="card" style={{ marginTop: 18, padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: '#c9d2ff' }}>Clicks</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr className="thead">
                <th className="th">Timestamp</th>
                <th className="th">Timezone</th>
                <th className="th">Source</th>
                <th className="th">Address Count</th>
                <th className="th">Sample Addresses</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 12, opacity: 0.7 }}>
                    No clicks yet. Paste addresses, then click a timezone.
                  </td>
                </tr>
              ) : (
                rows.map((row, idx) => (
                  <tr key={row.ts + idx} style={{ borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                    <td className="td">{row.ts}</td>
                    <td className="td">{row.zone}</td>
                    <td className="td">{row.source}</td>
                    <td className="td">{row.address_count}</td>
                    <td className="td">{row.sample}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: '#aab4d6' }}>
        Data: Timezone Boundary Builder (IANA tzdb). Fallback: Natural Earth. Basemap © OSM contributors.
      </div>
    </div>
  );
}

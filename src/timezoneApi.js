const API_BASE =
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3001'
    : '';

export async function detectTimezones(addresses = []) {
  const r = await fetch(`${API_BASE}/api/timezone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses }),
  });
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  return r.json();
}

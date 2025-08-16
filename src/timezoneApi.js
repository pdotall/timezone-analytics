export async function detectTimezones(addresses = []) {
  const r = await fetch('/api/timezone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses }),
  });
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  return r.json();
}

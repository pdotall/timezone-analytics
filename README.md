# UTC Timezones Frontend

A clean, aesthetic React frontend that renders **real-world timezone polygons** on a Leaflet map.

- Zones are transparent until clicked; clicking colors the zone.
- Paste crypto addresses (EVM 0x..., rough Solana Base58). Parsing is local-only.
- Clicking a zone appends a row to the log table. Clicking the same zone again toggles it off and removes the most recent row for that zone (LIFO).
- Data safety: We fetch Natural Earth timezones as TopoJSON, convert to GeoJSON in-browser, and **sanitize** geometry. If anything fails, a small fallback polygon is shown so the app still renders.

## Run (no bundler)
Open `index.html` directly in a browser. It loads React/ReactDOM + Babel and runs the component inline.

## Use in your React app
Copy `src/TimezoneMapUI.jsx` into your project and import it:

```jsx
import TimezoneMapUI from './TimezoneMapUI';
// ...
<TimezoneMapUI />
```

Make sure your app allows loading external scripts (Leaflet + TopoJSON client) from unpkg.

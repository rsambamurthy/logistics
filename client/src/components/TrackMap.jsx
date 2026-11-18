// Route and live vessel position on an OpenStreetMap base map. Used on the public tracking page and the job page.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export default function TrackMap({ path = [], position, height = 300 }) {
  const el = useRef(null);
  useEffect(() => {
    if (!el.current) return undefined;
    const map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true, worldCopyJump: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 10, attribution: '© OpenStreetMap contributors' }).addTo(map);
    const bounds = [];
    for (const seg of path || []) {
      const pts = (seg.points || []).filter((p) => Array.isArray(p) && p.length === 2);
      if (pts.length > 1) {
        L.polyline(pts, { color: '#0b6bff', weight: 3, opacity: 0.8, dashArray: seg.type === 'LAND' || seg.type === 'TRUCK' ? '6 6' : null }).addTo(map);
        bounds.push(...pts);
      }
    }
    if (position?.lat) {
      L.circleMarker([position.lat, position.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#ff6b00', fillOpacity: 1 }).addTo(map).bindTooltip('Current position');
      bounds.push([position.lat, position.lng]);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 6 });
    else map.setView([15, 90], 3);
    return () => map.remove();
  }, [JSON.stringify(path), position?.lat, position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} style={{ height, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)' }} />;
}

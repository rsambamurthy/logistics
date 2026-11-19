// Small line icons for the app frame (24×24, stroke = currentColor). Same set and style as VendorGate.
const PATHS = {
  dashboard: 'M4 13h6V4H4zM14 20h6V11h-6zM4 20h6v-4H4zM14 4v4h6V4z',
  rfqs: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8',
  plus: 'M12 5v14M5 12h14',
  jobs: 'M3 17h18l-2 4H5zM5 17V9h14v8M9 9V5h6v4M12 5V2',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  contacts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  pricing: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  config: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
  platform: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1',
  workspace: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1',
  chevron: 'M6 9l6 6 6-6',
  menu: 'M3 6h18M3 12h18M3 18h18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

export default function NavIcon({ name, size = 18 }) {
  return (
    <svg className="nav-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name] || ''} />
    </svg>
  );
}

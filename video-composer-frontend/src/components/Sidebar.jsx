// Persistent left navigation — compact icon rail.
//
// Exposes the three primary actions:
//   Export   → returns to / indicates the active composer (export) view
//   Record   → opens the existing RecordModal (handled by App)
//   Upload   → triggers the existing file-picker input (handled by App)
//
// This component is pure presentation: all behavior is delegated through
// props so the existing recording pipeline and upload flow are untouched.

function SidebarIcon({ name }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  // Download/export arrow: a downward arrow dropping onto a tray line.
  if (name === 'export') {
    return (
      <svg {...common}>
        <path d="M12 4v7" />
        <path d="M9 7l3 3 3 0 3-3" />
        <path d="M6 14h12" />
      </svg>
    )
  }

  if (name === 'record') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
    )
  }

  if (name === 'upload') {
    return (
      <svg {...common}>
        <path d="M12 16V4" />
        <path d="M5 11l7-7 7 7" />
        <path d="M5 20h14" />
      </svg>
    )
  }

  return null
}

function Sidebar({ activeSection, onSelectComposer, onSelectRecord, onSelectMedia }) {
  const items = [
    { key: 'media', label: 'My media', icon: 'upload', onClick: onSelectMedia },
    { key: 'record', label: 'Record', icon: 'record', onClick: onSelectRecord },
    { key: 'composer', label: 'Export', icon: 'export', onClick: onSelectComposer },
  ]

  return (
    <nav className="app-sidebar" aria-label="Primary">
      <div className="app-sidebar-brand">
        <span className="app-sidebar-brand-mark" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10 8.5v7l6-3.5-6-3.5z" fill="currentColor" />
          </svg>
        </span>
        <span className="app-sidebar-brand-text">AI STUDIO</span>
      </div>

      <ul className="app-sidebar-list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className={activeSection === item.key ? 'app-sidebar-item is-active' : 'app-sidebar-item'}
              onClick={item.onClick}
              disabled={item.disabled}
              title={item.label}
              aria-current={activeSection === item.key ? 'page' : undefined}
            >
              <SidebarIcon name={item.icon} />
              <span className="app-sidebar-item-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default Sidebar

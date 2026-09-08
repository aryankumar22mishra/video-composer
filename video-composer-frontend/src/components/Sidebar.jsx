// Persistent left navigation — OpenVid-style sidebar.
//
// Exposes the three primary actions:
//   Composer  → returns to / indicates the active composer view
//   Record    → opens the existing RecordModal (handled by App)
//   Upload    → triggers the existing file-picker input (handled by App)
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

  if (name === 'composer') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M3 8h18" />
        <path d="M8 3v18" />
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

function Sidebar({ activeSection, onSelectComposer, onSelectRecord, onSelectUpload }) {
  const items = [
    { key: 'composer', label: 'Composer', icon: 'composer', onClick: onSelectComposer },
    { key: 'record', label: 'Record', icon: 'record', onClick: onSelectRecord },
    { key: 'upload', label: 'Upload', icon: 'upload', onClick: onSelectUpload },
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

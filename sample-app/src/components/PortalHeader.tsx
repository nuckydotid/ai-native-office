export function PortalHeader() {
  return (
    <header className="portal-header">
      <a className="brand" href="#/" aria-label="Northwind Customer Portal home">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span>
          <strong>Northwind</strong>
          <small>Customer Portal</small>
        </span>
      </a>
      <nav aria-label="Portal sections">
        <a className="nav-link nav-link-active" href="#/" aria-current="page">
          Orders
        </a>
        <span className="nav-link nav-link-muted" title="Not part of this demo">
          Invoices
        </span>
        <span className="nav-link nav-link-muted" title="Not part of this demo">
          Support
        </span>
      </nav>
      <div className="header-meta">
        <span className="demo-chip">Synthetic data</span>
        <span className="avatar" aria-hidden="true">
          HO
        </span>
      </div>
    </header>
  );
}

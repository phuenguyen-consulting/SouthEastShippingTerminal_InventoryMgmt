import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import sstLogo from '../documents/SST_logo.png'
import './App.css'

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Main Switchboard', icon: '🧭' },
  { id: 'inbound', label: 'Cargo Inbound', icon: '🚢' },
  { id: 'outbound', label: 'Cargo Outbound', icon: '🚛' },
  { id: 'inventory', label: 'Cargo Inv Lathrop', icon: '📦' },
  { id: 'scanner', label: 'Scan In / Out', icon: '📷' },
  { id: 'documents', label: 'Cargo Bill Lathrop', icon: '🧾' },
  { id: 'history', label: 'Admin History', icon: '🛡️' },
]

const CARGO_TYPE_OPTIONS = ['Lumber', 'Paper Roll', 'Others']

const EMPTY_INBOUND = {
  cargoType: 'Lumber',
  customer: 'Canadian Wood Products',
  product: '2X8X16 ILIM',
  vessel: 'Amber Lagoon',
  voyageNo: 'US202501',
  inboundBol: '45526',
  customerMark: 'AIL-2',
  totalUnits: 20,
  location: 'Warehouse A-12',
  user: 'Terminal Clerk',
}

const EMPTY_OUTBOUND = {
  customer: 'Canadian Wood Products',
  cargoType: 'Lumber',
  inboundBol: '45526',
  customerMark: 'AIL-2',
  releaseNo: '49534',
  outboundBol: '35592',
  shipTo: 'Customer to Arrange',
  carrier: 'ABBY GRACE',
  unitsToShip: 1,
  user: 'Shipping Admin',
}

const EMPTY_SCAN = {
  mode: 'INBOUND',
  barcode: '',
  bolNumber: '',
  releaseNumber: '',
  location: 'Scan Lane A',
  user: 'Scanner01',
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : await response.text()

  if (!response.ok) {
    throw new Error(payload?.message || payload || 'Request failed')
  }

  return payload
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function lotStatus(lot) {
  if (lot.shipped === lot.total) return 'Closed'
  if (lot.available > 0) return 'Available'
  if (lot.received < lot.total) return 'Receiving'
  return 'Received'
}

function normalizeCargoType(value) {
  const raw = String(value || '').toLowerCase()
  if (raw.includes('paper')) return 'Paper Roll'
  if (raw.includes('lumber') || raw.includes('wood') || raw.includes('timber')) return 'Lumber'
  return 'Others'
}

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [message, setMessage] = useState('Loading cargo tracker data...')
  const [summary, setSummary] = useState({})
  const [units, setUnits] = useState([])
  const [history, setHistory] = useState([])
  const [shipments, setShipments] = useState([])
  const [selectedShipmentKey, setSelectedShipmentKey] = useState('')
  const [recentLabels, setRecentLabels] = useState([])
  const [inboundForm, setInboundForm] = useState(EMPTY_INBOUND)
  const [outboundForm, setOutboundForm] = useState(EMPTY_OUTBOUND)
  const [scanForm, setScanForm] = useState(EMPTY_SCAN)
  const [filters, setFilters] = useState({
    query: '',
    cargoType: 'ALL',
    status: 'ALL',
    releaseNo: '',
  })

  async function loadDashboard() {
    try {
      setLoading(true)
      const payload = await apiRequest('/api/dashboard')
      setSummary(payload.summary || {})
      setUnits(payload.units || [])
      setHistory(payload.history || [])
      setShipments(payload.shipments || [])
      setError(false)
      setMessage('SST inventory workspace is live and ready for inbound, outbound, scan, and audit operations.')
    } catch (requestError) {
      setError(true)
      setMessage(`${requestError.message}. Start the API with npm run dev:full or npm run server.`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDashboard()
  }, [])

  useEffect(() => {
    if (!recentLabels.length && units.length) {
      setRecentLabels(units.slice(0, 8).map((unit) => unit.barcode))
    }
  }, [units, recentLabels.length])

  const inventoryLots = useMemo(() => {
    const query = filters.query.trim().toLowerCase()
    const grouped = new Map()

    for (const unit of units) {
      const matchesQuery = !query || [
        unit.customer,
        unit.product,
        unit.vessel,
        unit.voyageNo,
        unit.inboundBol,
        unit.outboundBol,
        unit.customerMark,
        unit.releaseNo,
        unit.barcode,
      ].some((value) => String(value || '').toLowerCase().includes(query))

      const normalizedCargoType = normalizeCargoType(unit.cargoType)
      const matchesCargo = filters.cargoType === 'ALL' || normalizedCargoType === filters.cargoType
      const matchesStatus = filters.status === 'ALL' || unit.status === filters.status
      const matchesRelease = !filters.releaseNo || String(unit.releaseNo || '').toLowerCase().includes(filters.releaseNo.toLowerCase())

      if (!matchesQuery || !matchesCargo || !matchesStatus || !matchesRelease) continue

      const key = `${unit.inboundBol}|${unit.product}|${unit.customerMark}`
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          customer: unit.customer,
          cargoType: normalizedCargoType,
          product: unit.product,
          vessel: unit.vessel,
          voyageNo: unit.voyageNo,
          inboundBol: unit.inboundBol,
          customerMark: unit.customerMark,
          releaseNo: unit.releaseNo,
          location: unit.location,
          total: 0,
          received: 0,
          available: 0,
          shipped: 0,
          latestAt: unit.createdAt,
        })
      }

      const entry = grouped.get(key)
      entry.total += 1
      if (unit.status !== 'EXPECTED') entry.received += 1
      if (unit.status === 'IN_YARD') entry.available += 1
      if (unit.status === 'SHIPPED') entry.shipped += 1
      if (new Date(unit.createdAt) > new Date(entry.latestAt)) entry.latestAt = unit.createdAt
      if (unit.releaseNo) entry.releaseNo = unit.releaseNo
    }

    return Array.from(grouped.values()).sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt))
  }, [filters, units])

  const recentScans = useMemo(() => history.filter((item) => item.area === 'Barcode Scan').slice(0, 10), [history])

  useEffect(() => {
    if (shipments.length && !shipments.some((item) => item.key === selectedShipmentKey)) {
      setSelectedShipmentKey(shipments[0].key)
    }
  }, [shipments, selectedShipmentKey])

  const selectedShipment = useMemo(() => {
    return shipments.find((item) => item.key === selectedShipmentKey) || shipments[0] || null
  }, [shipments, selectedShipmentKey])

  function updateForm(setter, field, value) {
    setter((current) => ({ ...current, [field]: value }))
  }

  async function handleInboundSubmit(event) {
    event.preventDefault()

    try {
      const result = await apiRequest('/api/inbound', {
        method: 'POST',
        body: JSON.stringify(inboundForm),
      })
      setRecentLabels(result.createdBarcodes || [])
      setMessage(`Inbound manifest created. ${result.createdCount} barcode labels are ready for scan-in.`)
      setError(false)
      setInboundForm({ ...EMPTY_INBOUND, inboundBol: '', voyageNo: '', customerMark: '' })
      setActiveTab('scanner')
      await loadDashboard()
    } catch (requestError) {
      setError(true)
      setMessage(requestError.message)
    }
  }

  async function handleOutboundSubmit(event) {
    event.preventDefault()

    try {
      const result = await apiRequest('/api/outbound', {
        method: 'POST',
        body: JSON.stringify(outboundForm),
      })
      setMessage(`Outbound processed. ${result.shippedCount} of ${result.requested} requested units shipped on release ${outboundForm.releaseNo}. Bill of Lading is ready.`)
      setError(false)
      await loadDashboard()
      setSelectedShipmentKey(result.documentKey || '')
      setActiveTab('documents')
    } catch (requestError) {
      setError(true)
      setMessage(requestError.message)
    }
  }

  async function handleScanSubmit(event) {
    event.preventDefault()

    try {
      const result = await apiRequest('/api/scan', {
        method: 'POST',
        body: JSON.stringify(scanForm),
      })
      setMessage(result.message)
      setError(false)
      setScanForm((current) => ({ ...current, barcode: '' }))
      await loadDashboard()
    } catch (requestError) {
      setError(true)
      setMessage(requestError.message)
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer)
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' })

      const result = await apiRequest('/api/import', {
        method: 'POST',
        body: JSON.stringify({ rows, user: 'Excel Import Admin' }),
      })

      setMessage(`Excel import completed. ${result.importedCount} units added to the tracker.`)
      setError(false)
      await loadDashboard()
    } catch (requestError) {
      setError(true)
      setMessage(`Import failed: ${requestError.message}`)
    }

    event.target.value = ''
  }

  function exportFilteredData() {
    const rows = inventoryLots.map((lot) => ({
      Customer: lot.customer,
      CargoType: lot.cargoType,
      Product: lot.product,
      Vessel: lot.vessel,
      VoyageNo: lot.voyageNo,
      InboundBOL: lot.inboundBol,
      CustomerMark: lot.customerMark,
      ReleaseNo: lot.releaseNo,
      Received: `${lot.received}/${lot.total}`,
      Shipped: `${lot.shipped}/${lot.total}`,
      Available: lot.available,
      Location: lot.location,
      LotStatus: lotStatus(lot),
    }))

    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(workbook, sheet, 'Inventory Lots')
    XLSX.writeFile(workbook, 'SST_Inventory_Export.xlsx')
  }

  function downloadServerExport() {
    window.open('/api/export', '_blank', 'noopener,noreferrer')
  }

  function openBillOfLading(shipment = selectedShipment) {
    if (!shipment) return

    const bol = encodeURIComponent(shipment.outboundBol || '')
    const release = encodeURIComponent(shipment.releaseNo || '')
    window.open(`/api/bill-of-lading?outboundBol=${bol}&releaseNo=${release}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brandWrap">
          <img src={sstLogo} alt="Southeastern Ship Terminal" className="brandLogo" />
          <div>
            <h1>Inventory Tracking System</h1>
            <p className="subtitle">
              Modern web platform for lumber, paper rolls, vessel discharge, warehouse storage, barcode scan-in and scan-out, release-number search, audit history, and Excel workflows.
            </p>
            <p className="headerCredit">Website produced and managed by PXN AI and Analytics Consulting Sevices LLC</p>
          </div>
        </div>
        <div className="topbarBadges">
          <span>200,000 sq ft covered storage</span>
          <span>Breakbulk cargo operations</span>
          <span>Savannah terminal workflow</span>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`navButton ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => setActiveTab(item.id)}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}

          <div className="sidebarCard">
            <h3>Operational fit</h3>
            <ul>
              <li>Inbound vessel cargo intake</li>
              <li>Zebra-ready barcode creation</li>
              <li>Outbound BOL and release tracking</li>
              <li>Admin-visible user history</li>
              <li>Excel import and export</li>
            </ul>
          </div>
        </aside>

        <main className="content">
          <div className={`notice ${error ? 'error' : 'success'}`}>{message}</div>

          {activeTab === 'dashboard' && (
            <section className="tabSection">
              <div className="heroPanel">
                <div>
                  <p className="eyebrow">Legacy workflow modernized</p>
                  <h2>Main Switchboard</h2>
                  <p>
                    This dashboard mirrors the legacy SST screens for cargo inbound, cargo outbound, cargo inventory, scan history, and document creation while using a modern web stack.
                  </p>
                </div>
                <div className="heroSteps">
                  <strong>Legacy screen map</strong>
                  <span>1. Cargo Inbound</span>
                  <span>2. Scan In / Scan Out</span>
                  <span>3. Cargo Inv Lathrop</span>
                  <span>4. Cargo Bill Lathrop</span>
                </div>
              </div>

              <div className="statsGrid">
                <div className="statCard"><strong>{summary.onHand || 0}</strong><span>Units in yard</span></div>
                <div className="statCard"><strong>{summary.expected || 0}</strong><span>Expected units</span></div>
                <div className="statCard"><strong>{summary.shipped || 0}</strong><span>Units shipped</span></div>
                <div className="statCard"><strong>{summary.warehouseUtilization || 0}%</strong><span>Warehouse use</span></div>
                <div className="statCard"><strong>{summary.paperRolls || 0}</strong><span>Paper rolls</span></div>
                <div className="statCard"><strong>{summary.lumberUnits || 0}</strong><span>Lumber units</span></div>
              </div>

              <div className="panelGrid twoUp">
                <section className="panel">
                  <div className="panelHeader">
                    <h3>Inventory lots</h3>
                    <span>Inbound received and outbound shipped counts</span>
                  </div>
                  <div className="tableWrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Voyage</th>
                          <th>Received</th>
                          <th>Shipped</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventoryLots.slice(0, 8).map((lot) => (
                          <tr key={lot.key}>
                            <td>{lot.product}</td>
                            <td>{lot.voyageNo}</td>
                            <td>{lot.received}/{lot.total}</td>
                            <td>{lot.shipped}/{lot.total}</td>
                            <td><span className="statusPill">{lotStatus(lot)}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="panel">
                  <div className="panelHeader">
                    <h3>Recent audit activity</h3>
                    <span>Admin view of who changed the system</span>
                  </div>
                  <div className="historyList">
                    {history.slice(0, 6).map((item) => (
                      <div key={item.id} className="historyItem">
                        <strong>{item.action}</strong>
                        <span>{item.user} · {item.area}</span>
                        <p>{item.details}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </section>
          )}

          {activeTab === 'inbound' && (
            <section className="tabSection">
              <div className="panelGrid twoUp">
                <form className="panel" onSubmit={handleInboundSubmit}>
                  <div className="panelHeader">
                    <h3>Cargo Inbound</h3>
                    <span>Legacy Screen 1 · create vessel discharge records and barcode labels</span>
                  </div>
                  <div className="formGrid">
                    <label><span>Cargo type</span><select value={inboundForm.cargoType} onChange={(event) => updateForm(setInboundForm, 'cargoType', event.target.value)}>{CARGO_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                    <label><span>Customer</span><input value={inboundForm.customer} onChange={(event) => updateForm(setInboundForm, 'customer', event.target.value)} /></label>
                    <label><span>Product</span><input value={inboundForm.product} onChange={(event) => updateForm(setInboundForm, 'product', event.target.value)} /></label>
                    <label><span>Vessel</span><input value={inboundForm.vessel} onChange={(event) => updateForm(setInboundForm, 'vessel', event.target.value)} /></label>
                    <label><span>Voyage no.</span><input value={inboundForm.voyageNo} onChange={(event) => updateForm(setInboundForm, 'voyageNo', event.target.value)} /></label>
                    <label><span>Inbound BOL</span><input value={inboundForm.inboundBol} onChange={(event) => updateForm(setInboundForm, 'inboundBol', event.target.value)} /></label>
                    <label><span>Customer mark</span><input value={inboundForm.customerMark} onChange={(event) => updateForm(setInboundForm, 'customerMark', event.target.value)} /></label>
                    <label><span>Total units</span><input type="number" min="1" value={inboundForm.totalUnits} onChange={(event) => updateForm(setInboundForm, 'totalUnits', Number(event.target.value || 1))} /></label>
                    <label><span>Warehouse location</span><input value={inboundForm.location} onChange={(event) => updateForm(setInboundForm, 'location', event.target.value)} /></label>
                    <label><span>User</span><input value={inboundForm.user} onChange={(event) => updateForm(setInboundForm, 'user', event.target.value)} /></label>
                  </div>
                  <button className="primaryButton" type="submit">Create inbound manifest</button>
                </form>

                <section className="panel">
                  <div className="panelHeader">
                    <h3>Scanner label batch</h3>
                    <span>Ready for Zebra print workflow and handheld scan-in</span>
                  </div>
                  <div className="labelGrid">
                    {recentLabels.slice(0, 8).map((label) => (
                      <div key={label} className="barcodeLabel">
                        <div className="barcodeBars" />
                        <strong>{label}</strong>
                        <span>SST terminal label</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </section>
          )}

          {activeTab === 'outbound' && (
            <section className="tabSection">
              <div className="panelGrid twoUp">
                <form className="panel" onSubmit={handleOutboundSubmit}>
                  <div className="panelHeader">
                    <h3>Cargo Outbound</h3>
                    <span>Legacy outbound screen · search by release number and generate BOL</span>
                  </div>
                  <div className="formGrid">
                    <label><span>Customer</span><input value={outboundForm.customer} onChange={(event) => updateForm(setOutboundForm, 'customer', event.target.value)} /></label>
                    <label><span>Cargo type</span><select value={outboundForm.cargoType} onChange={(event) => updateForm(setOutboundForm, 'cargoType', event.target.value)}>{CARGO_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                    <label><span>Release number</span><input value={outboundForm.releaseNo} onChange={(event) => updateForm(setOutboundForm, 'releaseNo', event.target.value)} /></label>
                    <label><span>Outbound BOL</span><input value={outboundForm.outboundBol} onChange={(event) => updateForm(setOutboundForm, 'outboundBol', event.target.value)} /></label>
                    <label><span>Inbound BOL</span><input value={outboundForm.inboundBol} onChange={(event) => updateForm(setOutboundForm, 'inboundBol', event.target.value)} /></label>
                    <label><span>Customer mark</span><input value={outboundForm.customerMark} onChange={(event) => updateForm(setOutboundForm, 'customerMark', event.target.value)} /></label>
                    <label><span>Ship to</span><input value={outboundForm.shipTo} onChange={(event) => updateForm(setOutboundForm, 'shipTo', event.target.value)} /></label>
                    <label><span>Carrier</span><input value={outboundForm.carrier} onChange={(event) => updateForm(setOutboundForm, 'carrier', event.target.value)} /></label>
                    <label><span>Units to ship</span><input type="number" min="1" value={outboundForm.unitsToShip} onChange={(event) => updateForm(setOutboundForm, 'unitsToShip', Number(event.target.value || 1))} /></label>
                    <label><span>User</span><input value={outboundForm.user} onChange={(event) => updateForm(setOutboundForm, 'user', event.target.value)} /></label>
                  </div>
                  <button className="primaryButton" type="submit">Create outbound shipment</button>
                </form>

                <section className="panel">
                  <div className="panelHeader">
                    <h3>Bill of Lading preview</h3>
                    <span>Printable shipping document generated from outbound data</span>
                  </div>
                  <div className="lookupCard bolCard">
                    {selectedShipment ? (
                      <>
                        <strong>{selectedShipment.outboundBol}</strong>
                        <div className="metaGrid">
                          <div className="metaCell"><span>Release</span><strong>{selectedShipment.releaseNo}</strong></div>
                          <div className="metaCell"><span>Customer</span><strong>{selectedShipment.customer}</strong></div>
                          <div className="metaCell"><span>Carrier</span><strong>{selectedShipment.carrier}</strong></div>
                          <div className="metaCell"><span>Units</span><strong>{selectedShipment.units}</strong></div>
                        </div>
                        <ul>
                          <li>Search outbound by release number first</li>
                          <li>Validate the matching inbound BOL and customer mark</li>
                          <li>Open the generated BOL and print or save as PDF</li>
                        </ul>
                        <div className="buttonRow">
                          <button className="primaryButton" type="button" onClick={() => openBillOfLading(selectedShipment)}>Open BOL document</button>
                          <button className="secondaryButton" type="button" onClick={() => setActiveTab('documents')}>Open document center</button>
                        </div>
                      </>
                    ) : (
                      <p className="emptyState">Process an outbound shipment to generate the first Bill of Lading.</p>
                    )}
                  </div>
                </section>
              </div>
            </section>
          )}

          {activeTab === 'inventory' && (
            <section className="tabSection">
              <div className="panel">
                <div className="panelHeader">
                  <h3>Cargo Inv Lathrop</h3>
                  <span>Legacy customer inventory screen with release-number and BOL search</span>
                </div>
                <div className="toolbar">
                  <input placeholder="Search customer, product, voyage, BOL, barcode..." value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} />
                  <input placeholder="Release number" value={filters.releaseNo} onChange={(event) => setFilters((current) => ({ ...current, releaseNo: event.target.value }))} />
                  <select value={filters.cargoType} onChange={(event) => setFilters((current) => ({ ...current, cargoType: event.target.value }))}>
                    <option value="ALL">All cargo</option>
                    {CARGO_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                  <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
                    <option value="ALL">All status</option>
                    <option value="EXPECTED">Expected</option>
                    <option value="IN_YARD">In yard</option>
                    <option value="SHIPPED">Shipped</option>
                  </select>
                  <button className="secondaryButton" type="button" onClick={exportFilteredData}>Export filtered XLS</button>
                  <button className="secondaryButton" type="button" onClick={downloadServerExport}>Server export</button>
                  <label className="uploadLabel">
                    Import workbook
                    <input type="file" accept=".xlsx,.xls,.csv" onChange={handleImportFile} />
                  </label>
                </div>
                <div className="tableWrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th>Product</th>
                        <th>Voyage</th>
                        <th>Inbound BOL</th>
                        <th>Release</th>
                        <th>Received</th>
                        <th>Shipped</th>
                        <th>Available</th>
                        <th>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventoryLots.map((lot) => (
                        <tr key={lot.key}>
                          <td>{lot.customer}</td>
                          <td>{lot.product}</td>
                          <td>{lot.voyageNo}</td>
                          <td>{lot.inboundBol}</td>
                          <td>{lot.releaseNo || '—'}</td>
                          <td>{lot.received}/{lot.total}</td>
                          <td>{lot.shipped}/{lot.total}</td>
                          <td>{lot.available}</td>
                          <td>{lot.location}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'scanner' && (
            <section className="tabSection">
              <div className="panelGrid twoUp">
                <form className="panel" onSubmit={handleScanSubmit}>
                  <div className="panelHeader">
                    <h3>Scan In / Scan Out Lathrop</h3>
                    <span>Zebra scanner-compatible inbound and outbound capture</span>
                  </div>
                  <div className="formGrid">
                    <label><span>Mode</span><select value={scanForm.mode} onChange={(event) => updateForm(setScanForm, 'mode', event.target.value)}><option value="INBOUND">Inbound scan</option><option value="OUTBOUND">Outbound scan</option></select></label>
                    <label><span>Barcode</span><input autoFocus value={scanForm.barcode} onChange={(event) => updateForm(setScanForm, 'barcode', event.target.value)} placeholder="Scan or type barcode" /></label>
                    <label><span>BOL number</span><input value={scanForm.bolNumber} onChange={(event) => updateForm(setScanForm, 'bolNumber', event.target.value)} /></label>
                    <label><span>Release number</span><input value={scanForm.releaseNumber} onChange={(event) => updateForm(setScanForm, 'releaseNumber', event.target.value)} /></label>
                    <label><span>Location</span><input value={scanForm.location} onChange={(event) => updateForm(setScanForm, 'location', event.target.value)} /></label>
                    <label><span>User</span><input value={scanForm.user} onChange={(event) => updateForm(setScanForm, 'user', event.target.value)} /></label>
                  </div>
                  <button className="primaryButton" type="submit">Process scan</button>
                </form>

                <section className="panel">
                  <div className="panelHeader">
                    <h3>Recent scan history</h3>
                    <span>Shows received out of total and shipped out of total progress</span>
                  </div>
                  <div className="historyList compact">
                    {recentScans.length ? recentScans.map((item) => (
                      <div key={item.id} className="historyItem">
                        <strong>{item.action}</strong>
                        <span>{formatDate(item.at)} · {item.user}</span>
                        <p>{item.details}</p>
                      </div>
                    )) : <p>No scans recorded yet.</p>}
                  </div>
                </section>
              </div>
            </section>
          )}

          {activeTab === 'documents' && (
            <section className="tabSection">
              <div className="panelGrid twoUp">
                <section className="panel">
                  <div className="panelHeader">
                    <h3>Cargo Bill Lathrop</h3>
                    <span>Select a shipped load to open the generated Bill of Lading</span>
                  </div>
                  <div className="shipmentsList">
                    {shipments.length ? shipments.map((shipment) => (
                      <button
                        key={shipment.key}
                        type="button"
                        className={`shipmentRow ${selectedShipment?.key === shipment.key ? 'active' : ''}`}
                        onClick={() => setSelectedShipmentKey(shipment.key)}
                      >
                        <strong>{shipment.outboundBol}</strong>
                        <span>{shipment.releaseNo} · {shipment.customer}</span>
                        <small>{shipment.units} units · {formatDate(shipment.shippedAt)}</small>
                      </button>
                    )) : <p className="emptyState">No Bills of Lading are available yet.</p>}
                  </div>
                </section>

                <section className="panel">
                  <div className="panelHeader">
                    <h3>Document preview</h3>
                    <span>Printable Bill of Lading generated from the outbound shipment</span>
                  </div>
                  {selectedShipment ? (
                    <div className="bolCard">
                      <div className="metaGrid">
                        <div className="metaCell"><span>BOL No.</span><strong>{selectedShipment.outboundBol}</strong></div>
                        <div className="metaCell"><span>Release</span><strong>{selectedShipment.releaseNo}</strong></div>
                        <div className="metaCell"><span>Vessel / Voyage</span><strong>{selectedShipment.vessel} · {selectedShipment.voyageNo}</strong></div>
                        <div className="metaCell"><span>Ship To</span><strong>{selectedShipment.shipTo}</strong></div>
                        <div className="metaCell"><span>Carrier</span><strong>{selectedShipment.carrier}</strong></div>
                        <div className="metaCell"><span>Marks</span><strong>{selectedShipment.marks}</strong></div>
                      </div>
                      <div className="tableWrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Product</th>
                              <th>Inbound BOL</th>
                              <th>Mark</th>
                              <th>Units</th>
                              <th>Cargo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedShipment.lines.map((line, index) => (
                              <tr key={`${line.inboundBol}-${index}`}>
                                <td>{line.product}</td>
                                <td>{line.inboundBol}</td>
                                <td>{line.customerMark}</td>
                                <td>{line.quantity}</td>
                                <td>{line.cargoType}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="buttonRow">
                        <button className="primaryButton" type="button" onClick={() => openBillOfLading(selectedShipment)}>Open printable BOL</button>
                        <button className="secondaryButton" type="button" onClick={() => setActiveTab('outbound')}>Back to outbound</button>
                      </div>
                    </div>
                  ) : (
                    <p className="emptyState">Create or scan an outbound load to generate a Bill of Lading.</p>
                  )}
                </section>
              </div>
            </section>
          )}

          {activeTab === 'history' && (
            <section className="tabSection">
              <div className="panel">
                <div className="panelHeader">
                  <h3>Admin audit history</h3>
                  <span>Who changed what, when, and where in the system</span>
                </div>
                <div className="tableWrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date / Time</th>
                        <th>User</th>
                        <th>Area</th>
                        <th>Action</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((item) => (
                        <tr key={item.id}>
                          <td>{formatDate(item.at)}</td>
                          <td>{item.user}</td>
                          <td>{item.area}</td>
                          <td>{item.action}</td>
                          <td>{item.details}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {loading && <div className="loadingOverlay">Refreshing operational data…</div>}
        </main>
      </div>
    </div>
  )
}

export default App

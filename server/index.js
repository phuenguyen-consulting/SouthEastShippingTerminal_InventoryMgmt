import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'store.json')
const WAREHOUSE_CAPACITY_SQFT = 200000
const PORT = process.env.PORT || 4000

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function barcodePrefix(cargoType = '') {
  return String(cargoType).toLowerCase().includes('paper') ? 'PPR' : 'LMB'
}

function makeBarcodes(prefix, inboundBol, totalUnits) {
  return Array.from({ length: totalUnits }, (_, index) => {
    return `${prefix}-${String(inboundBol || 'SST').replace(/\s+/g, '').toUpperCase()}-${String(index + 1).padStart(3, '0')}`
  })
}

function createLotRecords(config) {
  const {
    cargoType,
    customer,
    product,
    vessel,
    voyageNo,
    inboundBol,
    customerMark,
    releaseNo = '',
    outboundBol = '',
    totalUnits,
    receivedUnits = totalUnits,
    shippedUnits = 0,
    location,
    shipTo = '',
    carrier = '',
    createdAt,
  } = config

  const barcodes = makeBarcodes(barcodePrefix(cargoType), inboundBol, totalUnits)

  return barcodes.map((barcode, index) => {
    const position = index + 1
    const status = position <= shippedUnits ? 'SHIPPED' : position <= receivedUnits ? 'IN_YARD' : 'EXPECTED'

    return {
      id: `UNIT-${String(voyageNo || inboundBol)}-${String(position).padStart(3, '0')}`,
      barcode,
      cargoType,
      customer,
      product,
      vessel,
      voyageNo,
      inboundBol,
      customerMark,
      releaseNo: status === 'SHIPPED' ? releaseNo : '',
      outboundBol: status === 'SHIPPED' ? outboundBol : '',
      location,
      shipTo: status === 'SHIPPED' ? shipTo : '',
      carrier: status === 'SHIPPED' ? carrier : '',
      createdAt,
      receivedAt: status !== 'EXPECTED' ? createdAt : '',
      shippedAt: status === 'SHIPPED' ? createdAt : '',
      status,
      quantity: 1,
    }
  })
}

function buildSeedStore() {
  const today = new Date().toISOString()
  const units = [
    ...createLotRecords({
      cargoType: 'Lumber',
      customer: 'Canadian Wood Products',
      product: '2X8X16 ILIM',
      vessel: 'Amber Lagoon',
      voyageNo: 'US202501',
      inboundBol: '45526',
      customerMark: 'AIL-2',
      releaseNo: '49534',
      outboundBol: '35592',
      totalUnits: 20,
      receivedUnits: 20,
      shippedUnits: 6,
      location: 'Warehouse A-12',
      shipTo: 'Customer to Arrange',
      carrier: 'ABBY GRACE',
      createdAt: '2025-04-10T12:00:00.000Z',
    }),
    ...createLotRecords({
      cargoType: 'Paper Roll',
      customer: 'International Paper',
      product: 'Kraft Paper Roll 42in',
      vessel: 'Rail / Van Intake',
      voyageNo: 'IP-10230268',
      inboundBol: 'TBOX642321',
      customerMark: 'GANDIA',
      releaseNo: 'POD-22017',
      outboundBol: 'PPR-87012',
      totalUnits: 12,
      receivedUnits: 10,
      shippedUnits: 4,
      location: 'Paper Bay P-04',
      shipTo: 'Gandia',
      carrier: 'Prepaid',
      createdAt: '2025-04-12T12:00:00.000Z',
    }),
    ...createLotRecords({
      cargoType: 'Lumber',
      customer: 'Scandinavian Timber',
      product: '2X12X14 Pine',
      vessel: 'Loch Lamond',
      voyageNo: '202420',
      inboundBol: 'LRP14',
      customerMark: 'TR14',
      totalUnits: 18,
      receivedUnits: 14,
      shippedUnits: 3,
      location: 'Yard Y-07',
      createdAt: '2025-04-15T12:00:00.000Z',
    }),
  ]

  const history = [
    {
      id: 'H-001',
      at: today,
      user: 'System Seed',
      action: 'Seeded demo inventory',
      area: 'Initialization',
      details: 'Loaded lumber and paper cargo examples based on SST operations.',
    },
  ]

  return {
    units,
    history,
    nextCounter: units.length + 100,
  }
}

function loadStore() {
  ensureDataDir()

  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  }

  const seed = buildSeedStore()
  fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2))
  return seed
}

let store = loadStore()

function saveStore() {
  ensureDataDir()
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2))
}

function logHistory(user, action, area, details) {
  store.history.unshift({
    id: `H-${store.nextCounter++}`,
    at: new Date().toISOString(),
    user: user || 'System',
    action,
    area,
    details,
  })
}

function sameDay(isoDate) {
  if (!isoDate) return false
  const today = new Date().toDateString()
  return new Date(isoDate).toDateString() === today
}

function computeSummary() {
  const onHand = store.units.filter((unit) => unit.status === 'IN_YARD').length
  const expected = store.units.filter((unit) => unit.status === 'EXPECTED').length
  const shipped = store.units.filter((unit) => unit.status === 'SHIPPED').length
  const receivedToday = store.units.filter((unit) => sameDay(unit.receivedAt)).length
  const shippedToday = store.units.filter((unit) => sameDay(unit.shippedAt)).length
  const paperRolls = store.units.filter((unit) => unit.cargoType === 'Paper Roll' && unit.status !== 'EXPECTED').length
  const lumberUnits = store.units.filter((unit) => unit.cargoType === 'Lumber' && unit.status !== 'EXPECTED').length
  const usedSqft = store.units.reduce((sum, unit) => {
    if (unit.status !== 'IN_YARD') return sum
    return sum + (unit.cargoType === 'Paper Roll' ? 80 : 150)
  }, 0)

  return {
    onHand,
    expected,
    shipped,
    receivedToday,
    shippedToday,
    paperRolls,
    lumberUnits,
    readyToShip: onHand,
    warehouseCapacity: WAREHOUSE_CAPACITY_SQFT,
    warehouseUtilization: Math.min(100, Math.round((usedSqft / WAREHOUSE_CAPACITY_SQFT) * 1000) / 10),
  }
}

function buildProgress(inboundBol) {
  const scoped = store.units.filter((unit) => unit.inboundBol === inboundBol)
  return {
    total: scoped.length,
    received: scoped.filter((unit) => unit.status !== 'EXPECTED').length,
    shipped: scoped.filter((unit) => unit.status === 'SHIPPED').length,
  }
}

function buildShipments() {
  const groups = new Map()

  store.units
    .filter((unit) => unit.status === 'SHIPPED')
    .forEach((unit) => {
      const key = `${unit.outboundBol || 'PENDING'}|${unit.releaseNo || 'NONE'}`

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          outboundBol: unit.outboundBol || 'Pending',
          releaseNo: unit.releaseNo || '—',
          customer: unit.customer,
          cargoType: unit.cargoType,
          vessel: unit.vessel,
          voyageNo: unit.voyageNo,
          shipTo: unit.shipTo || 'Customer to Arrange',
          carrier: unit.carrier || 'Prepaid',
          shippedAt: unit.shippedAt || unit.createdAt,
          marks: new Set(),
          locations: new Set(),
          lines: new Map(),
          units: 0,
        })
      }

      const shipment = groups.get(key)
      shipment.units += 1
      shipment.marks.add(unit.customerMark || '—')
      shipment.locations.add(unit.location || '—')

      const lineKey = `${unit.product}|${unit.inboundBol}`
      if (!shipment.lines.has(lineKey)) {
        shipment.lines.set(lineKey, {
          product: unit.product,
          inboundBol: unit.inboundBol,
          customerMark: unit.customerMark,
          quantity: 0,
          cargoType: unit.cargoType,
        })
      }

      shipment.lines.get(lineKey).quantity += 1
    })

  return Array.from(groups.values())
    .map((shipment) => ({
      ...shipment,
      marks: Array.from(shipment.marks).join(', '),
      locations: Array.from(shipment.locations).join(', '),
      lines: Array.from(shipment.lines.values()),
    }))
    .sort((a, b) => new Date(b.shippedAt) - new Date(a.shippedAt))
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderBillOfLading(shipment) {
  const linesMarkup = shipment.lines.map((line) => `
    <tr>
      <td>${escapeHtml(line.product)}</td>
      <td>${escapeHtml(line.inboundBol)}</td>
      <td>${escapeHtml(line.customerMark)}</td>
      <td>${line.quantity}</td>
      <td>${escapeHtml(line.cargoType)}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Bill of Lading ${escapeHtml(shipment.outboundBol)}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 24px; color: #10243a; background: #f5f9fd; }
        .sheet { max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid #d6e4f2; box-shadow: 0 14px 34px rgba(15,23,42,.08); }
        .header { padding: 20px 24px; background: linear-gradient(135deg, #0b1f37, #19456b); color: white; }
        .header h1 { margin: 0; font-size: 28px; }
        .header p { margin: 4px 0 0; color: #dbeafe; }
        .section { padding: 18px 24px; }
        .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .card { border: 1px solid #d7e3ef; border-radius: 10px; padding: 10px 12px; background: #f8fbff; }
        .card span { display: block; font-size: 11px; color: #60758c; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
        .card strong { font-size: 15px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #d7e3ef; padding: 8px 10px; text-align: left; font-size: 13px; }
        th { background: #eef6ff; text-transform: uppercase; font-size: 11px; letter-spacing: .06em; color: #526579; }
        .footer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
        .sign { border-top: 1px solid #94a3b8; padding-top: 8px; min-height: 40px; }
        .printbar { padding: 12px 24px 0; }
        .btn { border: 0; padding: 10px 14px; border-radius: 8px; background: #2563eb; color: white; font-weight: 700; }
        @media print { body { background: white; padding: 0; } .sheet { box-shadow: none; border: 0; } .printbar { display: none; } }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="printbar"><button class="btn" onclick="window.print()">Print Bill of Lading</button></div>
        <div class="header">
          <h1>Southeastern Ship Terminal</h1>
          <p>Bill of Lading · 355 North Lathrop Avenue · Savannah, GA 31415 · +1 (912) 234-8313</p>
        </div>
        <div class="section">
          <div class="meta">
            <div class="card"><span>Bill of Lading No.</span><strong>${escapeHtml(shipment.outboundBol)}</strong></div>
            <div class="card"><span>Release No.</span><strong>${escapeHtml(shipment.releaseNo)}</strong></div>
            <div class="card"><span>Customer</span><strong>${escapeHtml(shipment.customer)}</strong></div>
            <div class="card"><span>Carrier</span><strong>${escapeHtml(shipment.carrier)}</strong></div>
            <div class="card"><span>Ship To</span><strong>${escapeHtml(shipment.shipTo)}</strong></div>
            <div class="card"><span>Shipped At</span><strong>${new Date(shipment.shippedAt).toLocaleString('en-US')}</strong></div>
            <div class="card"><span>Vessel / Voyage</span><strong>${escapeHtml(shipment.vessel)} · ${escapeHtml(shipment.voyageNo)}</strong></div>
            <div class="card"><span>Customer Mark / Yard Location</span><strong>${escapeHtml(shipment.marks)} · ${escapeHtml(shipment.locations)}</strong></div>
          </div>
        </div>
        <div class="section">
          <table>
            <thead>
              <tr>
                <th>Product Description</th>
                <th>Inbound BOL</th>
                <th>Customer Mark</th>
                <th>Units</th>
                <th>Cargo Type</th>
              </tr>
            </thead>
            <tbody>${linesMarkup}</tbody>
          </table>
          <div class="footer">
            <div class="sign">Shipper / Terminal Representative</div>
            <div class="sign">Driver / Carrier Signature</div>
          </div>
        </div>
      </div>
    </body>
  </html>`
}

function parseRow(row) {
  const customer = row.customer || row.Customer || 'Imported Customer'
  const cargoType = row.cargoType || row['Cargo Type'] || row.Product || 'Lumber'
  const product = row.product || row.Product || row['Product Description'] || 'Imported Product'
  const vessel = row.vessel || row.Vessel || 'Imported Vessel'
  const voyageNo = String(row.voyageNo || row['Voyage No.'] || row.Voyage || `IMP-${store.nextCounter}`)
  const inboundBol = String(row.inboundBol || row['Inbound BOL'] || row.BOL || `IMPBOL-${store.nextCounter}`)
  const customerMark = String(row.customerMark || row['Cust Mark'] || row['Customer Mark'] || 'SST-IMP')
  const totalUnits = Math.max(1, Number(row.totalUnits || row['Units Discharged'] || row.Units || 1))
  const shippedUnits = Math.max(0, Number(row.shippedUnits || row['Units Shipped'] || 0))
  const receivedUnits = Math.max(shippedUnits, Number(row.receivedUnits || row['Units Received'] || totalUnits))
  const location = row.location || row.Location || 'Imported Yard'

  return {
    cargoType,
    customer,
    product,
    vessel,
    voyageNo,
    inboundBol,
    customerMark,
    totalUnits,
    receivedUnits,
    shippedUnits,
    location,
    createdAt: new Date().toISOString(),
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/dashboard', (_req, res) => {
  res.json({
    summary: computeSummary(),
    units: [...store.units].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    history: store.history.slice(0, 100),
    shipments: buildShipments(),
  })
})

app.get('/api/shipments', (_req, res) => {
  res.json({ shipments: buildShipments() })
})

app.post('/api/inbound', (req, res) => {
  const {
    cargoType = 'Lumber',
    customer = 'Unknown Customer',
    product = 'Unspecified Product',
    vessel = 'Unknown Vessel',
    voyageNo = `VOY-${store.nextCounter}`,
    inboundBol = `BOL-${store.nextCounter}`,
    customerMark = 'SST',
    totalUnits = 1,
    location = 'Warehouse A-01',
    user = 'Operations Clerk',
  } = req.body || {}

  const count = Math.max(1, Number(totalUnits) || 1)
  const createdAt = new Date().toISOString()
  const createdUnits = createLotRecords({
    cargoType,
    customer,
    product,
    vessel,
    voyageNo,
    inboundBol,
    customerMark,
    totalUnits: count,
    receivedUnits: 0,
    shippedUnits: 0,
    location,
    createdAt,
  })

  store.units.unshift(...createdUnits)
  logHistory(user, 'Created inbound manifest', 'Inbound Vessel Cargo', `${count} units created for voyage ${voyageNo} and BOL ${inboundBol}.`)
  saveStore()

  res.json({
    ok: true,
    createdCount: createdUnits.length,
    createdBarcodes: createdUnits.map((item) => item.barcode),
    progress: buildProgress(inboundBol),
  })
})

app.post('/api/outbound', (req, res) => {
  const {
    customer = '',
    cargoType = '',
    inboundBol = '',
    customerMark = '',
    releaseNo = `REL-${store.nextCounter}`,
    outboundBol = `OUT-${store.nextCounter}`,
    shipTo = 'Customer to Arrange',
    carrier = 'Prepaid',
    unitsToShip = 1,
    user = 'Shipping Clerk',
  } = req.body || {}

  const requested = Math.max(1, Number(unitsToShip) || 1)
  const available = store.units.filter((unit) => {
    return unit.status === 'IN_YARD'
      && (!customer || unit.customer === customer)
      && (!cargoType || unit.cargoType === cargoType)
      && (!inboundBol || unit.inboundBol === inboundBol)
      && (!customerMark || unit.customerMark === customerMark)
  })

  const shippedUnits = available.slice(0, requested)

  shippedUnits.forEach((unit) => {
    unit.status = 'SHIPPED'
    unit.releaseNo = releaseNo
    unit.outboundBol = outboundBol
    unit.shipTo = shipTo
    unit.carrier = carrier
    unit.shippedAt = new Date().toISOString()
  })

  logHistory(user, 'Processed outbound shipment', 'Cargo Outbound', `${shippedUnits.length} unit(s) assigned to release ${releaseNo} and BOL ${outboundBol}.`)
  saveStore()

  const progress = shippedUnits[0] ? buildProgress(shippedUnits[0].inboundBol) : { total: 0, received: 0, shipped: 0 }

  res.json({
    ok: true,
    requested,
    shippedCount: shippedUnits.length,
    shortage: Math.max(0, requested - shippedUnits.length),
    progress,
    documentKey: `${outboundBol || 'PENDING'}|${releaseNo || 'NONE'}`,
    bolUrl: `/api/bill-of-lading?outboundBol=${encodeURIComponent(outboundBol)}&releaseNo=${encodeURIComponent(releaseNo)}`,
  })
})

app.post('/api/scan', (req, res) => {
  const {
    mode = 'INBOUND',
    barcode = '',
    bolNumber = '',
    releaseNumber = '',
    location = 'Scan Lane',
    user = 'Scanner01',
  } = req.body || {}

  if (!barcode) {
    return res.status(400).json({ message: 'Barcode is required.' })
  }

  let unit = store.units.find((item) => item.barcode === barcode)

  if (!unit && mode === 'INBOUND') {
    unit = {
      id: `UNIT-${store.nextCounter++}`,
      barcode,
      cargoType: 'Lumber',
      customer: 'Ad hoc receipt',
      product: 'Scanned cargo',
      vessel: 'Manual scan',
      voyageNo: 'SCAN-NEW',
      inboundBol: bolNumber || `SCAN-${store.nextCounter}`,
      customerMark: 'SCAN',
      releaseNo: '',
      outboundBol: '',
      location,
      shipTo: '',
      carrier: '',
      createdAt: new Date().toISOString(),
      receivedAt: '',
      shippedAt: '',
      status: 'EXPECTED',
      quantity: 1,
    }
    store.units.unshift(unit)
  }

  if (!unit) {
    return res.status(404).json({ message: 'Barcode not found in inventory.' })
  }

  if (mode === 'INBOUND') {
    unit.status = 'IN_YARD'
    unit.receivedAt = new Date().toISOString()
    unit.inboundBol = bolNumber || unit.inboundBol
    unit.location = location || unit.location
    logHistory(user, 'Scanned cargo inbound', 'Barcode Scan', `${barcode} received into ${unit.location}.`)
  } else {
    unit.status = 'SHIPPED'
    unit.shippedAt = new Date().toISOString()
    unit.outboundBol = bolNumber || unit.outboundBol
    unit.releaseNo = releaseNumber || unit.releaseNo
    logHistory(user, 'Scanned cargo outbound', 'Barcode Scan', `${barcode} shipped on release ${unit.releaseNo || 'pending'}.`)
  }

  saveStore()

  const progress = buildProgress(unit.inboundBol)
  res.json({
    ok: true,
    unit,
    progress,
    message: `${progress.received} received out of ${progress.total}. ${progress.shipped} shipped out of ${progress.total}.`,
  })
})

app.post('/api/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  const user = req.body?.user || 'Import User'

  if (!rows.length) {
    return res.status(400).json({ message: 'No rows supplied for import.' })
  }

  const importedUnits = rows.flatMap((row) => createLotRecords(parseRow(row)))
  store.units.unshift(...importedUnits)
  logHistory(user, 'Imported workbook', 'Excel Import', `${importedUnits.length} unit(s) imported into the cargo tracker.`)
  saveStore()

  res.json({ ok: true, importedCount: importedUnits.length })
})

app.get('/api/export', (_req, res) => {
  const exportRows = store.units.map((unit) => ({
    Customer: unit.customer,
    CargoType: unit.cargoType,
    Product: unit.product,
    Vessel: unit.vessel,
    VoyageNo: unit.voyageNo,
    InboundBOL: unit.inboundBol,
    OutboundBOL: unit.outboundBol,
    ReleaseNo: unit.releaseNo,
    Barcode: unit.barcode,
    CustomerMark: unit.customerMark,
    Location: unit.location,
    Status: unit.status,
    ReceivedAt: unit.receivedAt,
    ShippedAt: unit.shippedAt,
  }))

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.json_to_sheet(exportRows)
  XLSX.utils.book_append_sheet(workbook, sheet, 'Inventory')
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename="sst-inventory-export.xlsx"')
  res.send(buffer)
})

app.get('/api/bill-of-lading', (req, res) => {
  const outboundBol = String(req.query.outboundBol || '')
  const releaseNo = String(req.query.releaseNo || '')

  const shipment = buildShipments().find((item) => {
    if (outboundBol && releaseNo) {
      return item.outboundBol === outboundBol || item.releaseNo === releaseNo
    }
    if (outboundBol) return item.outboundBol === outboundBol
    if (releaseNo) return item.releaseNo === releaseNo
    return false
  })

  if (!shipment) {
    return res.status(404).send('<h1>Bill of Lading not found</h1><p>No shipment matched the supplied release or BOL number.</p>')
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderBillOfLading(shipment))
})

app.listen(PORT, () => {
  console.log(`SST inventory API listening on http://localhost:${PORT}`)
})

import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import multer from 'multer'
import { Storage } from '@google-cloud/storage'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'store.json')
const DIST_DIR = path.join(__dirname, '..', 'dist')
const WAREHOUSE_CAPACITY_SQFT = 200000

// ── Dynamic port for Cloud Run ───────────────────────────────────────────────
const PORT = process.env.PORT || 4000
const HOST = '0.0.0.0'

// ── Google Cloud Storage configuration ──────────────────────────────────────
// GCS_BUCKET_NAME    : bucket for XLS uploads and persistent inventory store
// GCS_STORE_KEY      : path inside bucket for the inventory store JSON
// GCS_UPLOAD_PREFIX  : folder prefix for raw XLS upload files
// GCS_UPLOAD_MAX_MB  : max upload file size in MB (default 20)
const GCS_BUCKET_NAME   = process.env.GCS_BUCKET_NAME   || ''
const GCS_STORE_KEY     = process.env.GCS_STORE_KEY     || 'data/store.json'
const GCS_UPLOAD_PREFIX = process.env.GCS_UPLOAD_PREFIX || 'uploads/'
const GCS_UPLOAD_MAX_MB = parseInt(process.env.GCS_UPLOAD_MAX_MB || '20', 10)

const gcsClient = new Storage()

// ── Multer — memory storage for XLS file uploads ─────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: GCS_UPLOAD_MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xls|xlsx|csv)$/i)) {
      cb(null, true)
    } else {
      cb(new Error('Only XLS, XLSX, and CSV files are allowed.'))
    }
  },
})

// ── GCS helpers ──────────────────────────────────────────────────────────────
async function loadStoreFromGCS() {
  if (!GCS_BUCKET_NAME) return null
  try {
    const [contents] = await gcsClient.bucket(GCS_BUCKET_NAME).file(GCS_STORE_KEY).download()
    return JSON.parse(contents.toString('utf8'))
  } catch {
    return null
  }
}

async function saveStoreToGCS(data) {
  if (!GCS_BUCKET_NAME) return
  try {
    await gcsClient
      .bucket(GCS_BUCKET_NAME)
      .file(GCS_STORE_KEY)
      .save(JSON.stringify(data, null, 2), { contentType: 'application/json' })
  } catch (err) {
    console.error('GCS store save error:', err.message)
  }
}

async function uploadXlsToGCS(file) {
  if (!GCS_BUCKET_NAME) return null
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destPath = `${GCS_UPLOAD_PREFIX}${timestamp}_${file.originalname}`
  await gcsClient
    .bucket(GCS_BUCKET_NAME)
    .file(destPath)
    .save(file.buffer, { contentType: file.mimetype, metadata: { originalName: file.originalname } })
  return destPath
}

// ── Cargo type helpers ────────────────────────────────────────────────────────
function normalizeCargoType(value = '') {
  const raw = String(value || '').toLowerCase()
  if (raw.includes('paper')) return 'Paper Roll'
  if (raw.includes('lumber') || raw.includes('wood') || raw.includes('timber')) return 'Lumber'
  return 'Others'
}

function barcodePrefix(cargoType = '') {
  const normalized = normalizeCargoType(cargoType)
  if (normalized === 'Paper Roll') return 'PPR'
  if (normalized === 'Lumber') return 'LMB'
  return 'OTH'
}

function makeBarcodes(prefix, inboundBol, totalUnits) {
  return Array.from({ length: totalUnits }, (_, index) => {
    return `${prefix}-${String(inboundBol || 'SST').replace(/\s+/g, '').toUpperCase()}-${String(index + 1).padStart(3, '0')}`
  })
}

function createLotRecords(config) {
  const {
    cargoType, customer, product, vessel, voyageNo, inboundBol, customerMark,
    releaseNo = '', outboundBol = '', totalUnits,
    receivedUnits = totalUnits, shippedUnits = 0,
    location, shipTo = '', carrier = '', createdAt,
  } = config

  const normalizedCargoType = normalizeCargoType(cargoType)
  const barcodes = makeBarcodes(barcodePrefix(normalizedCargoType), inboundBol, totalUnits)

  return barcodes.map((barcode, index) => {
    const position = index + 1
    const status = position <= shippedUnits ? 'SHIPPED' : position <= receivedUnits ? 'IN_YARD' : 'EXPECTED'
    return {
      id: `UNIT-${String(voyageNo || inboundBol)}-${String(position).padStart(3, '0')}`,
      barcode, cargoType: normalizedCargoType, customer, product, vessel, voyageNo,
      inboundBol, customerMark,
      releaseNo: status === 'SHIPPED' ? releaseNo : '',
      outboundBol: status === 'SHIPPED' ? outboundBol : '',
      location,
      shipTo: status === 'SHIPPED' ? shipTo : '',
      carrier: status === 'SHIPPED' ? carrier : '',
      createdAt,
      receivedAt: status !== 'EXPECTED' ? createdAt : '',
      shippedAt: status === 'SHIPPED' ? createdAt : '',
      status, quantity: 1,
    }
  })
}

function buildSeedStore() {
  const today = new Date().toISOString()
  const units = [
    ...createLotRecords({
      cargoType: 'Lumber', customer: 'Canadian Wood Products', product: '2X8X16 ILIM',
      vessel: 'Amber Lagoon', voyageNo: 'US202501', inboundBol: '45526', customerMark: 'AIL-2',
      releaseNo: '49534', outboundBol: '35592', totalUnits: 20, receivedUnits: 20, shippedUnits: 6,
      location: 'Warehouse A-12', shipTo: 'Customer to Arrange', carrier: 'ABBY GRACE',
      createdAt: '2025-04-10T12:00:00.000Z',
    }),
    ...createLotRecords({
      cargoType: 'Paper Roll', customer: 'International Paper', product: 'Kraft Paper Roll 42in',
      vessel: 'Rail / Van Intake', voyageNo: 'IP-10230268', inboundBol: 'TBOX642321',
      customerMark: 'GANDIA', releaseNo: 'POD-22017', outboundBol: 'PPR-87012',
      totalUnits: 12, receivedUnits: 10, shippedUnits: 4,
      location: 'Paper Bay P-04', shipTo: 'Gandia', carrier: 'Prepaid',
      createdAt: '2025-04-12T12:00:00.000Z',
    }),
    ...createLotRecords({
      cargoType: 'Lumber', customer: 'Scandinavian Timber', product: '2X12X14 Pine',
      vessel: 'Loch Lamond', voyageNo: '202420', inboundBol: 'LRP14', customerMark: 'TR14',
      totalUnits: 18, receivedUnits: 14, shippedUnits: 3, location: 'Yard Y-07',
      createdAt: '2025-04-15T12:00:00.000Z',
    }),
  ]
  const history = [{
    id: 'H-001', at: today, user: 'System Seed',
    action: 'Seeded demo inventory', area: 'Initialization',
    details: 'Loaded lumber and paper cargo examples based on SST operations.',
  }]
  return { units, history, nextCounter: units.length + 100 }
}

// ── Store load / save (GCS-first, local fallback) ─────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function loadStoreLocal() {
  ensureDataDir()
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  const seed = buildSeedStore()
  fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2))
  return seed
}

let store = loadStoreLocal()

// On startup: try loading from GCS (persists data across Cloud Run restarts)
loadStoreFromGCS()
  .then((gcsStore) => {
    if (gcsStore) {
      store = gcsStore
      ensureDataDir()
      fs.writeFileSync(DATA_FILE, JSON.stringify(gcsStore, null, 2))
      console.log('Store loaded from GCS.')
    } else {
      console.log('GCS store not available — using local file or seed.')
    }
  })
  .catch(console.error)

function saveStore() {
  ensureDataDir()
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2))
  saveStoreToGCS(store) // async, best-effort
}

// ── Audit / summary helpers ──────────────────────────────────────────────────
function logHistory(user, action, area, details) {
  store.history.unshift({
    id: `H-${store.nextCounter++}`,
    at: new Date().toISOString(),
    user: user || 'System', action, area, details,
  })
}

function sameDay(isoDate) {
  if (!isoDate) return false
  return new Date(isoDate).toDateString() === new Date().toDateString()
}

function computeSummary() {
  const onHand = store.units.filter((u) => u.status === 'IN_YARD').length
  const expected = store.units.filter((u) => u.status === 'EXPECTED').length
  const shipped = store.units.filter((u) => u.status === 'SHIPPED').length
  const receivedToday = store.units.filter((u) => sameDay(u.receivedAt)).length
  const shippedToday = store.units.filter((u) => sameDay(u.shippedAt)).length
  const paperRolls = store.units.filter((u) => normalizeCargoType(u.cargoType) === 'Paper Roll' && u.status !== 'EXPECTED').length
  const lumberUnits = store.units.filter((u) => normalizeCargoType(u.cargoType) === 'Lumber' && u.status !== 'EXPECTED').length
  const usedSqft = store.units.reduce((sum, u) => u.status !== 'IN_YARD' ? sum : sum + (u.cargoType === 'Paper Roll' ? 80 : 150), 0)
  return {
    onHand, expected, shipped, receivedToday, shippedToday, paperRolls, lumberUnits,
    readyToShip: onHand, warehouseCapacity: WAREHOUSE_CAPACITY_SQFT,
    warehouseUtilization: Math.min(100, Math.round((usedSqft / WAREHOUSE_CAPACITY_SQFT) * 1000) / 10),
  }
}

function buildProgress(inboundBol) {
  const scoped = store.units.filter((u) => u.inboundBol === inboundBol)
  return {
    total: scoped.length,
    received: scoped.filter((u) => u.status !== 'EXPECTED').length,
    shipped: scoped.filter((u) => u.status === 'SHIPPED').length,
  }
}

function buildShipments() {
  const groups = new Map()
  store.units.filter((u) => u.status === 'SHIPPED').forEach((unit) => {
    const key = `${unit.outboundBol || 'PENDING'}|${unit.releaseNo || 'NONE'}`
    if (!groups.has(key)) {
      groups.set(key, {
        key, outboundBol: unit.outboundBol || 'Pending', releaseNo: unit.releaseNo || '—',
        customer: unit.customer, cargoType: unit.cargoType, vessel: unit.vessel,
        voyageNo: unit.voyageNo, shipTo: unit.shipTo || 'Customer to Arrange',
        carrier: unit.carrier || 'Prepaid', shippedAt: unit.shippedAt || unit.createdAt,
        marks: new Set(), locations: new Set(), lines: new Map(), units: 0,
      })
    }
    const s = groups.get(key)
    s.units += 1
    s.marks.add(unit.customerMark || '—')
    s.locations.add(unit.location || '—')
    const lk = `${unit.product}|${unit.inboundBol}`
    if (!s.lines.has(lk)) s.lines.set(lk, { product: unit.product, inboundBol: unit.inboundBol, customerMark: unit.customerMark, quantity: 0, cargoType: unit.cargoType })
    s.lines.get(lk).quantity += 1
  })
  return Array.from(groups.values())
    .map((s) => ({ ...s, marks: Array.from(s.marks).join(', '), locations: Array.from(s.locations).join(', '), lines: Array.from(s.lines.values()) }))
    .sort((a, b) => new Date(b.shippedAt) - new Date(a.shippedAt))
}

// ── Bill of Lading HTML renderer ─────────────────────────────────────────────
function escapeHtml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderBillOfLading(shipment) {
  const linesMarkup = shipment.lines.map((line) => `
    <tr>
      <td>${escapeHtml(line.product)}</td><td>${escapeHtml(line.inboundBol)}</td>
      <td>${escapeHtml(line.customerMark)}</td><td>${line.quantity}</td>
      <td>${escapeHtml(line.cargoType)}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Bill of Lading ${escapeHtml(shipment.outboundBol)}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 24px; color: #10243a; background: #f5f9fd; }
        .sheet { max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid #d6e4f2; box-shadow: 0 14px 34px rgba(15,23,42,.08); }
        .header { padding: 20px 24px; background: linear-gradient(135deg, #0b1f37, #19456b); color: white; }
        .header h1 { margin: 0; font-size: 28px; } .header p { margin: 4px 0 0; color: #dbeafe; }
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
            <thead><tr><th>Product Description</th><th>Inbound BOL</th><th>Customer Mark</th><th>Units</th><th>Cargo Type</th></tr></thead>
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

// ── XLS row parser ────────────────────────────────────────────────────────────
function parseRow(row) {
  const customer = row.customer || row.Customer || 'Imported Customer'
  const cargoType = normalizeCargoType(row.cargoType || row['Cargo Type'] || row.Product || 'Others')
  const product = row.product || row.Product || row['Product Description'] || 'Imported Product'
  const vessel = row.vessel || row.Vessel || 'Imported Vessel'
  const voyageNo = String(row.voyageNo || row['Voyage No.'] || row.Voyage || `IMP-${store.nextCounter}`)
  const inboundBol = String(row.inboundBol || row['Inbound BOL'] || row.BOL || `IMPBOL-${store.nextCounter}`)
  const customerMark = String(row.customerMark || row['Cust Mark'] || row['Customer Mark'] || 'SST-IMP')
  const totalUnits = Math.max(1, Number(row.totalUnits || row['Units Discharged'] || row.Units || 1))
  const shippedUnits = Math.max(0, Number(row.shippedUnits || row['Units Shipped'] || 0))
  const receivedUnits = Math.max(shippedUnits, Number(row.receivedUnits || row['Units Received'] || totalUnits))
  const location = row.location || row.Location || 'Imported Yard'
  return { cargoType, customer, product, vessel, voyageNo, inboundBol, customerMark, totalUnits, receivedUnits, shippedUnits, location, createdAt: new Date().toISOString() }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

// Serve built React frontend in production (dist/ exists after npm run build)
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.get('/api/dashboard', (_req, res) => {
  res.json({
    summary: computeSummary(),
    units: [...store.units].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    history: store.history.slice(0, 100),
    shipments: buildShipments(),
  })
})

app.get('/api/shipments', (_req, res) => res.json({ shipments: buildShipments() }))

app.post('/api/inbound', (req, res) => {
  const {
    cargoType = 'Lumber', customer = 'Unknown Customer', product = 'Unspecified Product',
    vessel = 'Unknown Vessel', voyageNo = `VOY-${store.nextCounter}`,
    inboundBol = `BOL-${store.nextCounter}`, customerMark = 'SST',
    totalUnits = 1, location = 'Warehouse A-01', user = 'Operations Clerk',
  } = req.body || {}

  const count = Math.max(1, Number(totalUnits) || 1)
  const createdAt = new Date().toISOString()
  const createdUnits = createLotRecords({ cargoType, customer, product, vessel, voyageNo, inboundBol, customerMark, totalUnits: count, receivedUnits: 0, shippedUnits: 0, location, createdAt })

  store.units.unshift(...createdUnits)
  logHistory(user, 'Created inbound manifest', 'Inbound Vessel Cargo', `${count} units created for voyage ${voyageNo} and BOL ${inboundBol}.`)
  saveStore()

  res.json({ ok: true, createdCount: createdUnits.length, createdBarcodes: createdUnits.map((i) => i.barcode), progress: buildProgress(inboundBol) })
})

app.post('/api/outbound', (req, res) => {
  const {
    customer = '', cargoType = '', inboundBol = '', customerMark = '',
    releaseNo = `REL-${store.nextCounter}`, outboundBol = `OUT-${store.nextCounter}`,
    shipTo = 'Customer to Arrange', carrier = 'Prepaid', unitsToShip = 1, user = 'Shipping Clerk',
  } = req.body || {}

  const requested = Math.max(1, Number(unitsToShip) || 1)
  const available = store.units.filter((u) =>
    u.status === 'IN_YARD'
    && (!customer || u.customer === customer)
    && (!cargoType || u.cargoType === cargoType)
    && (!inboundBol || u.inboundBol === inboundBol)
    && (!customerMark || u.customerMark === customerMark)
  )

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
  res.json({ ok: true, requested, shippedCount: shippedUnits.length, shortage: Math.max(0, requested - shippedUnits.length), progress, documentKey: `${outboundBol || 'PENDING'}|${releaseNo || 'NONE'}`, bolUrl: `/api/bill-of-lading?outboundBol=${encodeURIComponent(outboundBol)}&releaseNo=${encodeURIComponent(releaseNo)}` })
})

app.post('/api/scan', (req, res) => {
  const { mode = 'INBOUND', barcode = '', bolNumber = '', releaseNumber = '', location = 'Scan Lane', user = 'Scanner01' } = req.body || {}

  if (!barcode) return res.status(400).json({ message: 'Barcode is required.' })

  let unit = store.units.find((i) => i.barcode === barcode)

  if (!unit && mode === 'INBOUND') {
    unit = {
      id: `UNIT-${store.nextCounter++}`, barcode, cargoType: 'Lumber',
      customer: 'Ad hoc receipt', product: 'Scanned cargo', vessel: 'Manual scan',
      voyageNo: 'SCAN-NEW', inboundBol: bolNumber || `SCAN-${store.nextCounter}`,
      customerMark: 'SCAN', releaseNo: '', outboundBol: '', location,
      shipTo: '', carrier: '', createdAt: new Date().toISOString(),
      receivedAt: '', shippedAt: '', status: 'EXPECTED', quantity: 1,
    }
    store.units.unshift(unit)
  }

  if (!unit) return res.status(404).json({ message: 'Barcode not found in inventory.' })

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
  res.json({ ok: true, unit, progress, message: `${progress.received} received out of ${progress.total}. ${progress.shipped} shipped out of ${progress.total}.` })
})

app.post('/api/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  const user = req.body?.user || 'Import User'
  if (!rows.length) return res.status(400).json({ message: 'No rows supplied for import.' })

  const importedUnits = rows.flatMap((row) => createLotRecords(parseRow(row)))
  store.units.unshift(...importedUnits)
  logHistory(user, 'Imported workbook', 'Excel Import', `${importedUnits.length} unit(s) imported into the cargo tracker.`)
  saveStore()

  res.json({ ok: true, importedCount: importedUnits.length })
})

// Store the raw XLS file in GCS alongside the data import
app.post('/api/upload-workbook', upload.single('workbook'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' })
  if (!GCS_BUCKET_NAME) {
    return res.status(200).json({ stored: false, message: 'GCS_BUCKET_NAME not configured — file processed locally only.' })
  }
  try {
    const gcsPath = await uploadXlsToGCS(req.file)
    return res.status(200).json({ stored: true, gcsPath })
  } catch (err) {
    console.error('GCS XLS upload error:', err)
    return res.status(500).json({ error: 'Failed to store workbook in Google Cloud Storage.' })
  }
})

app.get('/api/export', (_req, res) => {
  const exportRows = store.units.map((unit) => ({
    Customer: unit.customer, CargoType: unit.cargoType, Product: unit.product,
    Vessel: unit.vessel, VoyageNo: unit.voyageNo, InboundBOL: unit.inboundBol,
    OutboundBOL: unit.outboundBol, ReleaseNo: unit.releaseNo, Barcode: unit.barcode,
    CustomerMark: unit.customerMark, Location: unit.location, Status: unit.status,
    ReceivedAt: unit.receivedAt, ShippedAt: unit.shippedAt,
  }))

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows), 'Inventory')
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename="sst-inventory-export.xlsx"')
  res.send(buffer)
})

app.get('/api/bill-of-lading', (req, res) => {
  const outboundBol = String(req.query.outboundBol || '')
  const releaseNo = String(req.query.releaseNo || '')

  const shipment = buildShipments().find((item) => {
    if (outboundBol && releaseNo) return item.outboundBol === outboundBol || item.releaseNo === releaseNo
    if (outboundBol) return item.outboundBol === outboundBol
    if (releaseNo) return item.releaseNo === releaseNo
    return false
  })

  if (!shipment) return res.status(404).send('<h1>Bill of Lading not found</h1><p>No shipment matched the supplied release or BOL number.</p>')

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderBillOfLading(shipment))
})

// SPA fallback — serve index.html for all non-API routes in production
if (fs.existsSync(DIST_DIR)) {
  app.use((_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
}

app.listen(PORT, HOST, () => {
  console.log(`SST inventory API listening on http://${HOST}:${PORT}`)
})

'use strict';

const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const auth = require('../middleware/auth');

const ACCESS_RANK = { none: 0, viewer: 1, editor: 2, administrator: 3 };
const ACTIVE_STATUSES = new Set(['active', 'returned', 'released', 'encashed', 'cancelled']);
const GUARANTEE_TYPES = new Set(['bid', 'performance', 'advance_payment', 'retention', 'customs', 'other']);
const COMPANIES = new Set(['VTX', 'VSN', 'ALL']);

const UPLOAD_DIR = path.join(__dirname, '../../uploads/guarantees');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png', 'image/webp',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `guarantee-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => ALLOWED_MIME.has(file.mimetype)
    ? cb(null, true) : cb(new Error('File type not allowed')),
});

async function requireAccess(level) {
  return async (req, res, next) => {
    try {
      if (req.user.role === 'admin') {
        req.guaranteeAccess = 'administrator';
        return next();
      }
      const { rows } = await db.query(
        'SELECT guarantee_access FROM users WHERE id=$1 AND active=true',
        [req.user.id]
      );
      const access = rows[0]?.guarantee_access || 'none';
      if ((ACCESS_RANK[access] || 0) < ACCESS_RANK[level]) {
        return res.status(403).json({ error: 'Bank Guarantee access required' });
      }
      req.guaranteeAccess = access;
      next();
    } catch (e) {
      console.error('[guarantee access]', e);
      res.status(500).json({ error: 'Server error' });
    }
  };
}

const viewAccess = requireAccess('viewer');
const editAccess = requireAccess('editor');
const adminAccess = requireAccess('administrator');

function computedStatusSql(alias = 'g') {
  return `CASE
    WHEN ${alias}.lifecycle_status <> 'active' THEN ${alias}.lifecycle_status
    WHEN ${alias}.current_expiry_date < CURRENT_DATE THEN 'expired'
    WHEN ${alias}.current_expiry_date <= CURRENT_DATE + 2 THEN 'expiring_soon'
    ELSE 'active'
  END`;
}

function cleanText(value, max = 1000) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out.slice(0, max) : null;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function parseGuarantee(body, partial = false) {
  const data = {
    company: cleanText(body.company, 10),
    guarantee_no: cleanText(body.guarantee_no, 120),
    issuing_bank: cleanText(body.issuing_bank, 150),
    bank_branch: cleanText(body.bank_branch, 200),
    beneficiary: cleanText(body.beneficiary, 250),
    guarantee_type: cleanText(body.guarantee_type, 40),
    issue_date: body.issue_date,
    original_expiry_date: body.original_expiry_date,
    current_expiry_date: body.current_expiry_date || body.original_expiry_date,
    amount: body.amount === '' || body.amount === null ? null : Number(body.amount),
    cash_margin_percent: body.cash_margin_percent === '' || body.cash_margin_percent === null || body.cash_margin_percent === undefined ? null : Number(body.cash_margin_percent),
    cash_margin_amount: body.cash_margin_amount === '' || body.cash_margin_amount === null || body.cash_margin_amount === undefined ? null : Number(body.cash_margin_amount),
    reference_no: cleanText(body.reference_no, 300),
    description: cleanText(body.description, 5000),
    lifecycle_status: cleanText(body.lifecycle_status, 20) || 'active',
    returned_date: body.returned_date || null,
    responsible_user_id: body.responsible_user_id ? Number(body.responsible_user_id) : null,
    remarks: cleanText(body.remarks, 5000),
  };
  if (!partial) {
    const required = ['company','guarantee_no','issuing_bank','beneficiary','guarantee_type','issue_date','original_expiry_date','current_expiry_date'];
    const missing = required.filter(k => !data[k]);
    if (missing.length || !Number.isFinite(data.amount)) throw new Error(`Required fields missing: ${missing.join(', ') || 'amount'}`);
  }
  if (data.company && !COMPANIES.has(data.company)) throw new Error('Invalid company');
  if (data.guarantee_type && !GUARANTEE_TYPES.has(data.guarantee_type)) throw new Error('Invalid guarantee type');
  if (data.lifecycle_status && !ACTIVE_STATUSES.has(data.lifecycle_status)) throw new Error('Invalid status');
  for (const key of ['issue_date','original_expiry_date','current_expiry_date']) {
    if (data[key] && !validDate(data[key])) throw new Error(`Invalid ${key.replaceAll('_', ' ')}`);
  }
  if (data.returned_date && !validDate(data.returned_date)) throw new Error('Invalid returned date');
  if (data.amount !== null && (!Number.isFinite(data.amount) || data.amount < 0)) throw new Error('Amount must be zero or greater');
  if (data.cash_margin_percent !== null && (!Number.isFinite(data.cash_margin_percent) || data.cash_margin_percent < 0 || data.cash_margin_percent > 100)) throw new Error('Cash margin percent must be between 0 and 100');
  if (data.current_expiry_date && data.issue_date && data.current_expiry_date < data.issue_date) throw new Error('Expiry date cannot be before issue date');
  return data;
}

async function audit(client, guaranteeId, action, userId, oldData, newData) {
  await client.query(
    `INSERT INTO guarantee_audit_log (guarantee_id, action, changed_by, old_data, new_data)
     VALUES ($1,$2,$3,$4,$5)`,
    [guaranteeId, action, userId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
  );
}

router.use(auth);

router.get('/summary', viewAccess, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE lifecycle_status='active')::int AS active_count,
        COUNT(*) FILTER (WHERE lifecycle_status='active' AND current_expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 2)::int AS expiring_count,
        COUNT(*) FILTER (WHERE lifecycle_status='active' AND current_expiry_date < CURRENT_DATE)::int AS expired_count,
        COUNT(*) FILTER (WHERE lifecycle_status IN ('returned','released') AND date_trunc('month', returned_date)=date_trunc('month', CURRENT_DATE))::int AS returned_month_count,
        COALESCE(SUM(amount) FILTER (WHERE lifecycle_status='active'),0) AS active_exposure
      FROM bank_guarantees WHERE deleted_at IS NULL`);
    res.json(rows[0]);
  } catch (e) {
    console.error('[guarantees summary]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/alerts', viewAccess, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT g.*, ${computedStatusSql('g')} AS computed_status,
             (g.current_expiry_date - CURRENT_DATE)::int AS remaining_days,
             u.name AS responsible_name
      FROM bank_guarantees g
      LEFT JOIN users u ON u.id=g.responsible_user_id
      WHERE g.deleted_at IS NULL AND g.lifecycle_status='active'
        AND g.current_expiry_date <= CURRENT_DATE + 2
      ORDER BY g.current_expiry_date, g.beneficiary`);
    res.json(rows);
  } catch (e) {
    console.error('[guarantees alerts]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/limits', viewAccess, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT l.*, COALESCE(x.used_amount,0) AS used_amount,
             l.sanctioned_limit - COALESCE(x.used_amount,0) AS remaining_amount
      FROM guarantee_bank_limits l
      LEFT JOIN (
        SELECT company, issuing_bank, SUM(amount) AS used_amount
        FROM bank_guarantees
        WHERE deleted_at IS NULL AND lifecycle_status='active'
        GROUP BY company, issuing_bank
      ) x ON x.company=l.company AND x.issuing_bank=l.issuing_bank
      ORDER BY l.company, l.issuing_bank`);
    res.json(rows);
  } catch (e) {
    console.error('[guarantee limits]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/history', viewAccess, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT e.*, g.guarantee_no, g.issuing_bank, g.beneficiary, g.company,
             u.name AS created_by_name
      FROM guarantee_extensions e
      JOIN bank_guarantees g ON g.id=e.guarantee_id AND g.deleted_at IS NULL
      JOIN users u ON u.id=e.created_by
      ORDER BY e.created_at DESC LIMIT 500`);
    res.json(rows);
  } catch (e) {
    console.error('[guarantee history]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/limits', adminAccess, async (req, res) => {
  const company = cleanText(req.body.company, 10);
  const issuingBank = cleanText(req.body.issuing_bank, 150);
  const limit = Number(req.body.sanctioned_limit);
  if (!COMPANIES.has(company) || !issuingBank || !Number.isFinite(limit) || limit < 0) {
    return res.status(400).json({ error: 'Valid company, bank and sanctioned limit are required' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO guarantee_bank_limits (company, issuing_bank, sanctioned_limit, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company, issuing_bank) DO UPDATE SET
         sanctioned_limit=EXCLUDED.sanctioned_limit, notes=EXCLUDED.notes,
         updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [company, issuingBank, limit, cleanText(req.body.notes, 2000), req.user.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[guarantee limit save]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/', viewAccess, async (req, res) => {
  const params = [];
  const where = ['g.deleted_at IS NULL'];
  const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
  if (req.query.search) {
    const value = `%${req.query.search}%`;
    params.push(value, value, value);
    where.push(`(g.guarantee_no ILIKE $${params.length-2} OR g.beneficiary ILIKE $${params.length-1} OR g.reference_no ILIKE $${params.length})`);
  }
  if (req.query.bank) add('g.issuing_bank = ?', req.query.bank);
  if (req.query.company) add('g.company = ?', req.query.company);
  if (req.query.type) add('g.guarantee_type = ?', req.query.type);
  if (req.query.status) {
    params.push(req.query.status);
    where.push(`${computedStatusSql('g')} = $${params.length}`);
  }
  try {
    const { rows } = await db.query(`
      SELECT g.*, ${computedStatusSql('g')} AS computed_status,
             (g.current_expiry_date - CURRENT_DATE)::int AS remaining_days,
             u.name AS responsible_name, cb.name AS created_by_name, ub.name AS updated_by_name,
             COUNT(*) OVER()::int AS total_count
      FROM bank_guarantees g
      LEFT JOIN users u ON u.id=g.responsible_user_id
      LEFT JOIN users cb ON cb.id=g.created_by
      LEFT JOIN users ub ON ub.id=g.updated_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN g.lifecycle_status='active' THEN 0 ELSE 1 END, g.current_expiry_date, g.id DESC
      LIMIT 1000`, params);
    res.json(rows);
  } catch (e) {
    console.error('[guarantees list]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', editAccess, async (req, res) => {
  let data;
  try { data = parseGuarantee(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO bank_guarantees
       (company, guarantee_no, issuing_bank, bank_branch, beneficiary, guarantee_type,
        issue_date, original_expiry_date, current_expiry_date, amount, cash_margin_percent,
        cash_margin_amount, reference_no, description, lifecycle_status, returned_date,
        responsible_user_id, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
       RETURNING *`,
      [data.company,data.guarantee_no,data.issuing_bank,data.bank_branch,data.beneficiary,
       data.guarantee_type,data.issue_date,data.original_expiry_date,data.current_expiry_date,
       data.amount,data.cash_margin_percent,data.cash_margin_amount,data.reference_no,
       data.description,data.lifecycle_status,data.returned_date,data.responsible_user_id,
       data.remarks,req.user.id]
    );
    await audit(client, rows[0].id, 'created', req.user.id, null, rows[0]);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'This bank and guarantee number already exist' });
    console.error('[guarantee create]', e);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.get('/:id', viewAccess, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT g.*, ${computedStatusSql('g')} AS computed_status,
             (g.current_expiry_date - CURRENT_DATE)::int AS remaining_days,
             u.name AS responsible_name, cb.name AS created_by_name, ub.name AS updated_by_name
      FROM bank_guarantees g
      LEFT JOIN users u ON u.id=g.responsible_user_id
      LEFT JOIN users cb ON cb.id=g.created_by
      LEFT JOIN users ub ON ub.id=g.updated_by
      WHERE g.id=$1 AND g.deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Guarantee not found' });
    const [extensions, documents, auditLog] = await Promise.all([
      db.query(`SELECT e.*, u.name AS created_by_name FROM guarantee_extensions e JOIN users u ON u.id=e.created_by WHERE e.guarantee_id=$1 ORDER BY e.created_at DESC`, [req.params.id]),
      db.query(`SELECT d.*, u.name AS uploaded_by_name FROM guarantee_documents d JOIN users u ON u.id=d.uploaded_by WHERE d.guarantee_id=$1 ORDER BY d.uploaded_at DESC`, [req.params.id]),
      db.query(`SELECT a.*, u.name AS changed_by_name FROM guarantee_audit_log a JOIN users u ON u.id=a.changed_by WHERE a.guarantee_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [req.params.id]),
    ]);
    res.json({ ...rows[0], extensions: extensions.rows, documents: documents.rows, audit: auditLog.rows });
  } catch (e) {
    console.error('[guarantee detail]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', editAccess, async (req, res) => {
  let data;
  try { data = parseGuarantee(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guarantee not found' }); }
    const { rows } = await client.query(
      `UPDATE bank_guarantees SET company=$1, guarantee_no=$2, issuing_bank=$3, bank_branch=$4,
       beneficiary=$5, guarantee_type=$6, issue_date=$7, original_expiry_date=$8,
       current_expiry_date=$9, amount=$10, cash_margin_percent=$11, cash_margin_amount=$12,
       reference_no=$13, description=$14, lifecycle_status=$15, returned_date=$16,
       responsible_user_id=$17, remarks=$18, updated_by=$19, updated_at=NOW()
       WHERE id=$20 RETURNING *`,
      [data.company,data.guarantee_no,data.issuing_bank,data.bank_branch,data.beneficiary,
       data.guarantee_type,data.issue_date,data.original_expiry_date,data.current_expiry_date,
       data.amount,data.cash_margin_percent,data.cash_margin_amount,data.reference_no,
       data.description,data.lifecycle_status,data.returned_date,data.responsible_user_id,
       data.remarks,req.user.id,req.params.id]
    );
    await audit(client, old.id, 'updated', req.user.id, old, rows[0]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'This bank and guarantee number already exist' });
    console.error('[guarantee update]', e);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.post('/:id/extensions', editAccess, async (req, res) => {
  const newDate = req.body.new_expiry_date;
  if (!validDate(newDate)) return res.status(400).json({ error: 'Valid new expiry date is required' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const guarantee = (await client.query('SELECT * FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0];
    if (!guarantee) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guarantee not found' }); }
    const previous = String(guarantee.current_expiry_date).slice(0, 10);
    if (newDate < previous) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'New expiry date cannot be earlier than the current expiry date' }); }
    const { rows } = await client.query(
      `INSERT INTO guarantee_extensions (guarantee_id, previous_expiry_date, new_expiry_date, amendment_no, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, previous, newDate, cleanText(req.body.amendment_no,150), cleanText(req.body.remarks,3000), req.user.id]
    );
    await client.query('UPDATE bank_guarantees SET current_expiry_date=$1, updated_by=$2, updated_at=NOW() WHERE id=$3', [newDate, req.user.id, req.params.id]);
    await audit(client, guarantee.id, 'extended', req.user.id, { current_expiry_date: previous }, { current_expiry_date: newDate, extension_id: rows[0].id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[guarantee extension]', e);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.post('/:id/close', editAccess, async (req, res) => {
  const status = cleanText(req.body.status, 20);
  if (!['returned','released','encashed','cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid closing status' });
  const date = req.body.returned_date || new Date().toISOString().slice(0,10);
  if (!validDate(date)) return res.status(400).json({ error: 'Valid closing date is required' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guarantee not found' }); }
    const { rows } = await client.query(
      `UPDATE bank_guarantees SET lifecycle_status=$1, returned_date=$2, remarks=COALESCE($3,remarks), updated_by=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [status, date, cleanText(req.body.remarks,5000), req.user.id, req.params.id]
    );
    await audit(client, old.id, status, req.user.id, old, rows[0]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[guarantee close]', e);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.post('/:id/documents', editAccess, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const exists = await db.query('SELECT id FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL', [req.params.id]);
    if (!exists.rows.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Guarantee not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO guarantee_documents
       (guarantee_id, document_type, original_name, stored_name, mime_type, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, cleanText(req.body.document_type,40) || 'guarantee', req.file.originalname,
       req.file.filename, req.file.mimetype, req.file.size, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    console.error('[guarantee document upload]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/documents/:documentId/download', viewAccess, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM guarantee_documents WHERE id=$1', [req.params.documentId]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    const filePath = path.join(UPLOAD_DIR, rows[0].stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Document file is missing' });
    res.download(filePath, rows[0].original_name);
  } catch (e) {
    console.error('[guarantee document download]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/documents/:documentId', editAccess, async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM guarantee_documents WHERE id=$1 RETURNING *', [req.params.documentId]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    fs.unlink(path.join(UPLOAD_DIR, rows[0].stored_name), () => {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[guarantee document delete]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', adminAccess, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guarantee not found' }); }
    await audit(client, old.id, 'deleted', req.user.id, old, null);
    await client.query('UPDATE bank_guarantees SET deleted_at=NOW(), deleted_by=$1, updated_by=$1, updated_at=NOW() WHERE id=$2', [req.user.id, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[guarantee delete]', e);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large — maximum 20 MB' });
  res.status(400).json({ error: err.message || 'Upload error' });
});

module.exports = router;

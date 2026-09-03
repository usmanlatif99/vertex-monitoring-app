'use strict';

const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const auth = require('../middleware/auth');

const ACCESS_RANK = { none: 0, viewer: 1, editor: 2, administrator: 3 };
const ACTIVE_STATUSES = new Set(['active', 'returned', 'encashed', 'cancelled']);
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

function requireAccess(level) {
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
    WHEN ${alias}.current_expiry_date <= CURRENT_DATE + 7 THEN 'expiring_soon'
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

function optionalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!validDate(value)) throw new Error('Invalid date in unconfirmed record');
  return value;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid number in unconfirmed record');
  return number;
}

function normalizedLifecycle(value) {
  const status = cleanText(value, 20) || 'active';
  return status === 'released' ? 'returned' : status;
}

function parseGuarantee(body, partial = false) {
  const data = {
    company: cleanText(body.company, 10),
    guarantee_no: cleanText(body.guarantee_no, 120),
    bank_id: body.bank_id ? Number(body.bank_id) : null,
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
    const required = ['company','guarantee_no','bank_id','beneficiary','guarantee_type','issue_date','original_expiry_date','current_expiry_date'];
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

async function resolveBank(client, bankId, allowInactive = false) {
  if (!Number.isInteger(Number(bankId)) || Number(bankId) < 1) throw new Error('Select a valid issuing bank');
  const { rows } = await client.query(
    `SELECT id, name, active FROM guarantee_banks WHERE id=$1${allowInactive ? '' : ' AND active=true'}`,
    [bankId]
  );
  if (!rows[0]) throw new Error('Selected issuing bank is unavailable');
  return rows[0];
}

async function audit(client, guaranteeId, action, userId, oldData, newData) {
  await client.query(
    `INSERT INTO guarantee_audit_log (guarantee_id, action, changed_by, old_data, new_data)
     VALUES ($1,$2,$3,$4,$5)`,
    [guaranteeId, action, userId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null]
  );
}

router.use(auth);

router.get('/banks', viewAccess, async (req, res) => {
  try {
    const includeInactive = req.guaranteeAccess === 'administrator' && req.query.all === '1';
    const { rows } = await db.query(
      `SELECT b.id, b.name, b.active, b.created_at,
              COUNT(g.id) FILTER (WHERE g.deleted_at IS NULL)::int AS guarantee_count
       FROM guarantee_banks b
       LEFT JOIN bank_guarantees g ON g.bank_id=b.id
       ${includeInactive ? '' : 'WHERE b.active=true'}
       GROUP BY b.id ORDER BY b.active DESC, b.name`
    );
    res.json(rows);
  } catch (e) {
    console.error('[guarantee banks]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/banks', adminAccess, async (req, res) => {
  const name = cleanText(req.body.name, 150);
  if (!name) return res.status(400).json({ error: 'Bank name is required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO guarantee_banks (name, created_by) VALUES ($1,$2)
       RETURNING id, name, active, created_at`, [name, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This bank already exists' });
    console.error('[guarantee bank create]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/banks/:bankId', adminAccess, async (req, res) => {
  const name = cleanText(req.body.name, 150);
  if (!name) return res.status(400).json({ error: 'Bank name is required' });
  const active = req.body.active !== false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const oldBank = await resolveBank(client, req.params.bankId, true);
    const { rows } = await client.query(
      `UPDATE guarantee_banks SET name=$1, active=$2, updated_at=NOW() WHERE id=$3
       RETURNING id, name, active, created_at`, [name, active, oldBank.id]
    );
    if (oldBank.name !== name) {
      await client.query('UPDATE bank_guarantees SET issuing_bank=$1 WHERE bank_id=$2', [name, oldBank.id]);
      await client.query('UPDATE guarantee_bank_limits SET issuing_bank=$1 WHERE bank_id=$2', [name, oldBank.id]);
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'This bank name conflicts with an existing bank or record' });
    res.status(e.message?.includes('bank') ? 400 : 500).json({ error: e.message?.includes('bank') ? e.message : 'Server error' });
  } finally { client.release(); }
});

router.get('/summary', viewAccess, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE lifecycle_status='active')::int AS active_count,
        COUNT(*) FILTER (WHERE lifecycle_status='active' AND current_expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS expiring_count,
        COUNT(*) FILTER (WHERE lifecycle_status='active' AND current_expiry_date < CURRENT_DATE)::int AS expired_count,
        COUNT(*) FILTER (WHERE lifecycle_status='returned' AND date_trunc('month', returned_date)=date_trunc('month', CURRENT_DATE))::int AS returned_month_count,
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
        AND g.current_expiry_date <= CURRENT_DATE + 7
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

router.get('/unconfirmed', adminAccess, async (req, res) => {
  const state = ['unconfirmed','confirmed','excluded'].includes(req.query.state) ? req.query.state : 'unconfirmed';
  try {
    const { rows } = await db.query(
      `SELECT q.*, b.name AS selected_bank_name, u.name AS reviewed_by_name
       FROM guarantee_unconfirmed_imports q
       LEFT JOIN guarantee_banks b ON b.id=q.bank_id
       LEFT JOIN users u ON u.id=q.reviewed_by
       WHERE q.review_state=$1
       ORDER BY CASE WHEN q.lifecycle_status='active' THEN 0 ELSE 1 END, q.source_sheet, q.source_row`,
      [state]
    );
    res.json(rows);
  } catch (e) {
    console.error('[unconfirmed guarantees]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/unconfirmed/import', adminAccess, async (req, res) => {
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  if (!records.length || records.length > 500) return res.status(400).json({ error: 'Provide between 1 and 500 records' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let imported = 0;
    for (const record of records) {
      const sourceSheet = cleanText(record.source_sheet, 120);
      const sourceRow = Number(record.source_row);
      const issues = cleanText(record.review_issues, 5000);
      if (!sourceSheet || !Number.isInteger(sourceRow) || sourceRow < 1 || !issues) throw new Error('Source sheet, row and review issues are required');
      const lifecycle = normalizedLifecycle(record.lifecycle_status);
      const values = [
        sourceSheet, sourceRow, cleanText(record.guarantee_no,120), cleanText(record.company,10),
        cleanText(record.issuing_bank,150), record.bank_id ? Number(record.bank_id) : null,
        cleanText(record.beneficiary,250), cleanText(record.guarantee_type,40),
        optionalDate(record.issue_date), optionalDate(record.original_expiry_date), optionalDate(record.current_expiry_date),
        optionalNumber(record.amount), optionalNumber(record.cash_margin_percent), cleanText(record.reference_no,300),
        cleanText(record.description,5000), cleanText(record.source_status,80), lifecycle,
        optionalDate(record.returned_date), cleanText(record.remarks,5000), issues, JSON.stringify(record.raw_data || record),
      ];
      await client.query(
        `INSERT INTO guarantee_unconfirmed_imports
         (source_sheet,source_row,guarantee_no,company,issuing_bank,bank_id,beneficiary,guarantee_type,
          issue_date,original_expiry_date,current_expiry_date,amount,cash_margin_percent,reference_no,
          description,source_status,lifecycle_status,returned_date,remarks,review_issues,raw_data)
         VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})
         ON CONFLICT (source_sheet,source_row) DO UPDATE SET
          guarantee_no=EXCLUDED.guarantee_no, company=EXCLUDED.company, issuing_bank=EXCLUDED.issuing_bank,
          bank_id=EXCLUDED.bank_id, beneficiary=EXCLUDED.beneficiary, guarantee_type=EXCLUDED.guarantee_type,
          issue_date=EXCLUDED.issue_date, original_expiry_date=EXCLUDED.original_expiry_date,
          current_expiry_date=EXCLUDED.current_expiry_date, amount=EXCLUDED.amount,
          cash_margin_percent=EXCLUDED.cash_margin_percent, reference_no=EXCLUDED.reference_no,
          description=EXCLUDED.description, source_status=EXCLUDED.source_status,
          lifecycle_status=EXCLUDED.lifecycle_status, returned_date=EXCLUDED.returned_date,
          remarks=EXCLUDED.remarks, review_issues=EXCLUDED.review_issues, raw_data=EXCLUDED.raw_data,
          updated_at=NOW()
         WHERE guarantee_unconfirmed_imports.review_state='unconfirmed'`, values
      );
      imported++;
    }
    await client.query('COMMIT');
    res.status(201).json({ imported });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[unconfirmed import]', e);
    res.status(400).json({ error: e.message || 'Import failed' });
  } finally { client.release(); }
});

router.put('/unconfirmed/:id', adminAccess, async (req, res) => {
  try {
    const lifecycle = normalizedLifecycle(req.body.lifecycle_status);
    const { rows } = await db.query(
      `UPDATE guarantee_unconfirmed_imports SET
       guarantee_no=$1, company=$2, bank_id=$3, beneficiary=$4, guarantee_type=$5,
       issue_date=$6, original_expiry_date=$7, current_expiry_date=$8, amount=$9,
       cash_margin_percent=$10, reference_no=$11, description=$12, lifecycle_status=$13,
       returned_date=$14, remarks=$15, admin_note=$16, reviewed_by=$17, reviewed_at=NOW(), updated_at=NOW()
       WHERE id=$18 AND review_state='unconfirmed' RETURNING *`,
      [cleanText(req.body.guarantee_no,120),cleanText(req.body.company,10),req.body.bank_id?Number(req.body.bank_id):null,
       cleanText(req.body.beneficiary,250),cleanText(req.body.guarantee_type,40),optionalDate(req.body.issue_date),
       optionalDate(req.body.original_expiry_date),optionalDate(req.body.current_expiry_date),optionalNumber(req.body.amount),
       optionalNumber(req.body.cash_margin_percent),cleanText(req.body.reference_no,300),cleanText(req.body.description,5000),
       lifecycle,optionalDate(req.body.returned_date),cleanText(req.body.remarks,5000),cleanText(req.body.admin_note,5000),
       req.user.id,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Unconfirmed record not found' });
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message || 'Unable to save record' }); }
});

router.post('/unconfirmed/:id/confirm', adminAccess, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const source = (await client.query(
      `SELECT * FROM guarantee_unconfirmed_imports WHERE id=$1 AND review_state='unconfirmed' FOR UPDATE`,
      [req.params.id]
    )).rows[0];
    if (!source) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Unconfirmed record not found' }); }
    const data = parseGuarantee({ ...source, lifecycle_status: normalizedLifecycle(source.lifecycle_status) });
    const bank = await resolveBank(client, data.bank_id);
    const { rows } = await client.query(
      `INSERT INTO bank_guarantees
       (company,guarantee_no,issuing_bank,bank_id,bank_branch,beneficiary,guarantee_type,
        issue_date,original_expiry_date,current_expiry_date,amount,cash_margin_percent,cash_margin_amount,
        reference_no,description,lifecycle_status,returned_date,responsible_user_id,remarks,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING *`,
      [data.company,data.guarantee_no,bank.name,bank.id,data.bank_branch,data.beneficiary,data.guarantee_type,
       data.issue_date,data.original_expiry_date,data.current_expiry_date,data.amount,data.cash_margin_percent,
       data.cash_margin_amount,data.reference_no,data.description,data.lifecycle_status,data.returned_date,
       data.responsible_user_id,data.remarks,req.user.id]
    );
    await audit(client, rows[0].id, 'confirmed_from_import', req.user.id, null, rows[0]);
    await client.query(
      `UPDATE guarantee_unconfirmed_imports SET review_state='confirmed',confirmed_guarantee_id=$1,
       reviewed_by=$2,reviewed_at=NOW(),updated_at=NOW() WHERE id=$3`,
      [rows[0].id,req.user.id,source.id]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'This bank and guarantee number already exist' });
    res.status(400).json({ error: e.message || 'Confirmation failed' });
  } finally { client.release(); }
});

router.post('/unconfirmed/:id/exclude', adminAccess, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE guarantee_unconfirmed_imports SET review_state='excluded',admin_note=$1,reviewed_by=$2,
     reviewed_at=NOW(),updated_at=NOW() WHERE id=$3 AND review_state='unconfirmed' RETURNING *`,
    [cleanText(req.body.admin_note,5000),req.user.id,req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Unconfirmed record not found' });
  res.json(rows[0]);
});

router.put('/limits', adminAccess, async (req, res) => {
  const company = cleanText(req.body.company, 10);
  const bankId = Number(req.body.bank_id);
  const limit = Number(req.body.sanctioned_limit);
  if (!COMPANIES.has(company) || !Number.isInteger(bankId) || !Number.isFinite(limit) || limit < 0) {
    return res.status(400).json({ error: 'Valid company, bank and sanctioned limit are required' });
  }
  try {
    const bank = await resolveBank(db, bankId);
    const { rows } = await db.query(
      `INSERT INTO guarantee_bank_limits (company, issuing_bank, bank_id, sanctioned_limit, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company, issuing_bank) DO UPDATE SET
         bank_id=EXCLUDED.bank_id, sanctioned_limit=EXCLUDED.sanctioned_limit, notes=EXCLUDED.notes,
         updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [company, bank.name, bank.id, limit, cleanText(req.body.notes, 2000), req.user.id]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.message?.includes('issuing bank')) return res.status(400).json({ error: e.message });
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
    const bank = await resolveBank(client, data.bank_id);
    const { rows } = await client.query(
      `INSERT INTO bank_guarantees
       (company, guarantee_no, issuing_bank, bank_id, bank_branch, beneficiary, guarantee_type,
        issue_date, original_expiry_date, current_expiry_date, amount, cash_margin_percent,
        cash_margin_amount, reference_no, description, lifecycle_status, returned_date,
        responsible_user_id, remarks, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
       RETURNING *`,
      [data.company,data.guarantee_no,bank.name,bank.id,data.bank_branch,data.beneficiary,
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
    if (e.message?.includes('issuing bank')) return res.status(400).json({ error: e.message });
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
    const bank = await resolveBank(client, data.bank_id, Number(data.bank_id) === Number(old.bank_id));
    const { rows } = await client.query(
      `UPDATE bank_guarantees SET company=$1, guarantee_no=$2, issuing_bank=$3, bank_id=$4, bank_branch=$5,
       beneficiary=$6, guarantee_type=$7, issue_date=$8, original_expiry_date=$9,
       current_expiry_date=$10, amount=$11, cash_margin_percent=$12, cash_margin_amount=$13,
       reference_no=$14, description=$15, lifecycle_status=$16, returned_date=$17,
       responsible_user_id=$18, remarks=$19, updated_by=$20, updated_at=NOW()
       WHERE id=$21 RETURNING *`,
      [data.company,data.guarantee_no,bank.name,bank.id,data.bank_branch,data.beneficiary,
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
    if (e.message?.includes('issuing bank')) return res.status(400).json({ error: e.message });
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

router.post('/:id/close', adminAccess, async (req, res) => {
  const status = cleanText(req.body.status, 20);
  if (!['returned','encashed','cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid closing status' });
  const date = req.body.returned_date || new Date().toISOString().slice(0,10);
  if (!validDate(date)) return res.status(400).json({ error: 'Valid closing date is required' });
  const remarks = cleanText(req.body.remarks, 5000);
  if (!remarks) return res.status(400).json({ error: 'Closing remarks are required' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guarantee not found' }); }
    if (old.lifecycle_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only an active guarantee can be closed' });
    }
    const { rows } = await client.query(
      `UPDATE bank_guarantees SET lifecycle_status=$1, returned_date=$2, remarks=COALESCE($3,remarks), updated_by=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [status, date, remarks, req.user.id, req.params.id]
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

router.post('/:id/reopen', adminAccess, async (req, res) => {
  const reason = cleanText(req.body.reason, 5000);
  if (!reason) return res.status(400).json({ error: 'Reopening reason is required' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query(
      'SELECT * FROM bank_guarantees WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    )).rows[0];
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guarantee not found' }); }
    if (old.lifecycle_status === 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Guarantee is already active' });
    }
    const { rows } = await client.query(
      `UPDATE bank_guarantees
       SET lifecycle_status='active', returned_date=NULL, updated_by=$1, updated_at=NOW()
       WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await audit(client, old.id, 'reopened', req.user.id, old, {
      ...rows[0], previous_status: old.lifecycle_status, reopening_reason: reason,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[guarantee reopen]', e);
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

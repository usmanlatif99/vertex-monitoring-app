'use strict';
const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { verifyAssertion } = require('./webauthn');

const OFFICE_LAT = 31.441300523433583;
const OFFICE_LNG = 74.32441912480384;
const ALLOWED_M  = 100; // metres

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getCheckinStatus(ts) {
  // Returns 'present' | 'late' | 'halfday' based on PKT time
  const pkt  = new Date(new Date(ts).getTime() + 5 * 3600 * 1000);
  const mins = pkt.getUTCHours() * 60 + pkt.getUTCMinutes();
  if (mins >= 11 * 60)          return 'halfday'; // 11:00 AM or later
  if (mins > 9 * 60 + 35)      return 'late';    // after 9:35 AM
  return 'present';
}

function pktMinutes(ts) {
  const pkt = new Date(new Date(ts).getTime() + 5 * 3600 * 1000);
  return pkt.getUTCHours() * 60 + pkt.getUTCMinutes();
}

function todayPKT() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── Employee endpoints ─────────────────────────────────────────────────────────

// GET /api/attendance/today
router.get('/today', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, ab.name AS approved_by_name
       FROM attendance a
       LEFT JOIN users ab ON ab.id = a.approved_by
       WHERE a.user_id = $1 AND a.date = $2`,
      [req.user.id, todayPKT()]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/attendance/my?month=YYYY-MM
router.get('/my', auth, async (req, res) => {
  const month = (req.query.month || todayPKT().slice(0, 7));
  const [y, m] = month.split('-');
  try {
    const { rows } = await db.query(
      `SELECT * FROM attendance
       WHERE user_id = $1
         AND date >= $2::date
         AND date < ($2::date + INTERVAL '1 month')
       ORDER BY date`,
      [req.user.id, `${y}-${m}-01`]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/attendance/checkin
router.post('/checkin', auth, async (req, res) => {
  const { type, lat, lng, remark, assertion, accuracy } = req.body;
  const today = todayPKT();
  const now   = new Date();

  try {
    // Check attendance_enabled
    const { rows: uRows } = await db.query(
      'SELECT attendance_enabled FROM users WHERE id = $1', [req.user.id]
    );
    if (!uRows[0]?.attendance_enabled) {
      return res.status(403).json({ error: 'Attendance tracking not enabled for your account' });
    }

    const { rows: existing } = await db.query(
      'SELECT id, check_in_at FROM attendance WHERE user_id = $1 AND date = $2',
      [req.user.id, today]
    );
    if (existing[0]?.check_in_at) {
      return res.status(409).json({ error: 'Already checked in today' });
    }

    // Enforce check-in window: 7:00 AM – no upper limit (after 11 AM = halfday)
    const nowMins = pktMinutes(now);
    if (nowMins < 7 * 60) {
      return res.status(400).json({ error: 'Check-in is not allowed before 7:00 AM. Office opens at 7:00 AM.' });
    }

    // Check whether employee has an approved WebAuthn credential
    const { rows: credRows } = await db.query(
      `SELECT id FROM attendance_credentials WHERE user_id = $1 AND status = 'approved' LIMIT 1`,
      [req.user.id]
    );
    const hasApprovedDevice = credRows.length > 0;

    let checkInType;
    let approvalStatus = 'approved';
    let distance = null;
    let credentialDbId = null;

    if (assertion) {
      // WebAuthn path
      checkInType = 'webauthn';
      const verified = await verifyAssertion(req.user.id, assertion, 'checkin');
      credentialDbId = verified.credentialDbId;

      // GPS still required for WebAuthn check-in
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'GPS location required for check-in' });
      }
      distance = haversineM(OFFICE_LAT, OFFICE_LNG, parseFloat(lat), parseFloat(lng));
      if (distance > ALLOWED_M) {
        return res.status(400).json({
          error: `You are ${Math.round(distance)}m from office (limit: ${ALLOWED_M}m). You must be at the office to check in.`,
        });
      }
    } else if (type === 'location') {
      if (hasApprovedDevice) {
        return res.status(403).json({
          error: 'Your account has a registered device. Please use biometric check-in.',
          requireWebAuthn: true,
        });
      }
      checkInType = 'location';
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Location coordinates required' });
      }
      distance = haversineM(OFFICE_LAT, OFFICE_LNG, parseFloat(lat), parseFloat(lng));
      if (distance > ALLOWED_M) {
        return res.status(400).json({
          error: `You are ${Math.round(distance)}m from office (limit: ${ALLOWED_M}m). Use manual check-in if your GPS is not working.`,
        });
      }
    } else if (type === 'manual') {
      if (hasApprovedDevice) {
        return res.status(403).json({
          error: 'Your account has a registered device. Please use biometric check-in.',
          requireWebAuthn: true,
        });
      }
      checkInType = 'manual';
      approvalStatus = 'pending';
    } else {
      return res.status(400).json({ error: 'Invalid check-in type' });
    }

    const status = getCheckinStatus(now);
    const clientIp = req.ip || req.connection?.remoteAddress || null;
    const userAgent = (req.headers['user-agent'] || '').slice(0, 500);

    const { rows } = await db.query(
      `INSERT INTO attendance
         (user_id, date, check_in_at, check_in_lat, check_in_lng,
          status, check_in_type, checkin_remark, approval_status,
          att_credential_id, verification_mode, gps_accuracy, client_ip, user_agent_str, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (user_id, date) DO UPDATE
         SET check_in_at = $3, check_in_lat = $4, check_in_lng = $5,
             status = $6, check_in_type = $7, checkin_remark = $8, approval_status = $9,
             att_credential_id = $10, verification_mode = $11, gps_accuracy = $12,
             client_ip = $13, user_agent_str = $14, verified_at = $15
       RETURNING *`,
      [req.user.id, today, now, lat || null, lng || null,
       status, checkInType, remark || null, approvalStatus,
       credentialDbId, checkInType, accuracy || null, clientIp, userAgent,
       checkInType === 'webauthn' ? now : null]
    );
    res.json({ ...rows[0], distance });
  } catch (e) {
    if (e.message && (e.message.includes('challenge') || e.message.includes('verification') || e.message.includes('device'))) {
      return res.status(400).json({ error: e.message });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/attendance/checkout
router.post('/checkout', auth, async (req, res) => {
  const { type, lat, lng, remark, assertion, accuracy } = req.body;
  const today = todayPKT();
  const now   = new Date();

  try {
    const { rows: existing } = await db.query(
      'SELECT * FROM attendance WHERE user_id = $1 AND date = $2',
      [req.user.id, today]
    );
    const rec = existing[0];
    if (!rec || !rec.check_in_at) {
      return res.status(400).json({ error: 'No check-in found for today — check in first' });
    }
    if (rec.check_out_at) {
      return res.status(409).json({ error: 'Already checked out today' });
    }

    // Check whether employee has an approved WebAuthn credential
    const { rows: credRows } = await db.query(
      `SELECT id FROM attendance_credentials WHERE user_id = $1 AND status = 'approved' LIMIT 1`,
      [req.user.id]
    );
    const hasApprovedDevice = credRows.length > 0;

    let checkOutType;
    let approvalStatus = rec.approval_status; // inherit check-in approval status
    let distance = null;

    if (assertion) {
      checkOutType = 'webauthn';
      await verifyAssertion(req.user.id, assertion, 'checkout');

      if (lat != null && lng != null) {
        distance = haversineM(OFFICE_LAT, OFFICE_LNG, parseFloat(lat), parseFloat(lng));
        if (distance > ALLOWED_M) {
          // Out-of-office WebAuthn checkout — still allowed but flag for review
          approvalStatus = 'pending';
        }
      }
    } else if (type === 'location') {
      if (hasApprovedDevice) {
        return res.status(403).json({
          error: 'Your account has a registered device. Please use biometric checkout.',
          requireWebAuthn: true,
        });
      }
      checkOutType = 'location';
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Location coordinates required' });
      }
      distance = haversineM(OFFICE_LAT, OFFICE_LNG, parseFloat(lat), parseFloat(lng));
      if (distance > ALLOWED_M) {
        return res.status(400).json({
          error: `You are ${Math.round(distance)}m from office. Use "Out of Office" checkout if you have left early.`,
        });
      }
    } else if (type === 'out_of_office') {
      if (!remark || !remark.trim()) {
        return res.status(400).json({ error: 'Reason is required for out-of-office checkout' });
      }
      checkOutType = 'out_of_office';
      approvalStatus = 'pending';
    } else if (type === 'manual') {
      if (hasApprovedDevice) {
        return res.status(403).json({
          error: 'Your account has a registered device. Please use biometric checkout.',
          requireWebAuthn: true,
        });
      }
      checkOutType = 'manual';
      approvalStatus = 'pending';
    } else {
      return res.status(400).json({ error: 'Invalid checkout type' });
    }

    const { rows } = await db.query(
      `UPDATE attendance
       SET check_out_at = $1, check_out_lat = $2, check_out_lng = $3,
           check_out_type = $4, checkout_remark = $5, approval_status = $6
       WHERE id = $7
       RETURNING *`,
      [now, lat || null, lng || null, checkOutType, remark || null, approvalStatus, rec.id]
    );
    res.json({ ...rows[0], distance });
  } catch (e) {
    if (e.message && (e.message.includes('challenge') || e.message.includes('verification') || e.message.includes('device'))) {
      return res.status(400).json({ error: e.message });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin endpoints ────────────────────────────────────────────────────────────

// GET /api/attendance/admin/daily?date=YYYY-MM-DD
router.get('/admin/daily', auth, adminOnly, async (req, res) => {
  const date = req.query.date || todayPKT();
  try {
    const { rows: users } = await db.query(
      `SELECT id, name, department, company FROM users
       WHERE role = 'employee' AND active = true AND attendance_enabled = true
       ORDER BY company, name`
    );
    const { rows: records } = await db.query(
      `SELECT a.*, u.name AS user_name, u.department, u.company,
              ab.name AS approved_by_name
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN users ab ON ab.id = a.approved_by
       WHERE a.date = $1
       ORDER BY u.name`,
      [date]
    );
    const { rows: autoCounts } = await db.query(
      `SELECT user_id, COUNT(*)::int AS count
       FROM attendance
       WHERE auto_checked_out = TRUE
         AND date_trunc('month', date) = date_trunc('month', $1::date)
       GROUP BY user_id`,
      [date]
    );
    const autoByUser = {};
    autoCounts.forEach(r => { autoByUser[r.user_id] = r.count; });
    const recByUser = {};
    records.forEach(r => { recByUser[r.user_id] = r; });
    res.json(users.map(u => ({ ...u, record: recByUser[u.id] || null, auto_checkout_count: autoByUser[u.id] || 0 })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/attendance/admin/monthly?month=YYYY-MM
router.get('/admin/monthly', auth, adminOnly, async (req, res) => {
  const month = req.query.month || todayPKT().slice(0, 7);
  const [y, m] = month.split('-');
  try {
    const { rows: users } = await db.query(
      `SELECT id, name, department, company FROM users
       WHERE role = 'employee' AND active = true AND attendance_enabled = true
       ORDER BY company, name`
    );
    if (!users.length) return res.json([]);

    const { rows: records } = await db.query(
      `SELECT * FROM attendance
       WHERE user_id = ANY($1)
         AND date >= $2::date
         AND date < ($2::date + INTERVAL '1 month')
       ORDER BY user_id, date`,
      [users.map(u => u.id), `${y}-${m}-01`]
    );

    const daysInMonth = new Date(parseInt(y), parseInt(m), 0).getDate();
    const today = todayPKT();
    let elapsedWork = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (ds > today) break;
      if (new Date(ds + 'T00:00:00').getDay() !== 0) elapsedWork++;
    }

    const byUser = {};
    records.forEach(r => { (byUser[r.user_id] = byUser[r.user_id] || []).push(r); });

    const result = users.map(u => {
      const recs     = byUser[u.id] || [];
      const approved = recs.filter(r => r.approval_status === 'approved');
      const present  = approved.filter(r => r.status === 'present').length;
      const late     = approved.filter(r => r.status === 'late').length;
      const halfday  = approved.filter(r => r.status === 'halfday').length;
      const lateAbsents    = Math.floor(late / 3);
      const halfdayAbsents = Math.floor(halfday / 2);
      const rawAbsent      = Math.max(0, elapsedWork - present - late - halfday);
      const absent         = rawAbsent + lateAbsents + halfdayAbsents;
      return { ...u, present, late, halfday, absent, lateAbsents, halfdayAbsents, elapsedWork, daysInMonth, records: recs };
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/attendance/admin/pending
router.get('/admin/pending', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, u.name AS user_name, u.department, u.company
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       WHERE a.approval_status = 'pending'
       ORDER BY a.date DESC, u.name`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/attendance/admin/approve/:id
router.put('/admin/approve/:id', auth, adminOnly, async (req, res) => {
  const { action, admin_note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "reject"' });
  }
  try {
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const { rows } = await db.query(
      `UPDATE attendance
       SET approval_status = $1, approved_by = $2, approved_at = NOW(),
           admin_note = COALESCE($3, admin_note)
       WHERE id = $4
       RETURNING *`,
      [newStatus, req.user.id, admin_note || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/attendance/admin/edit/:id — manual correction
router.put('/admin/edit/:id', auth, adminOnly, async (req, res) => {
  const { check_in_at, check_out_at, status, admin_note, approval_status } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE attendance
       SET check_in_at      = COALESCE($1, check_in_at),
           check_out_at     = COALESCE($2, check_out_at),
           status           = COALESCE($3, status),
           admin_note       = COALESCE($4, admin_note),
           approval_status  = COALESCE($5, approval_status),
           approved_by      = $6,
           approved_at      = NOW()
       WHERE id = $7
       RETURNING *`,
      [check_in_at || null, check_out_at || null, status || null,
       admin_note || null, approval_status || null, req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/attendance/admin/manual — admin marks attendance for an employee
router.post('/admin/manual', auth, adminOnly, async (req, res) => {
  const { user_id, date, check_in_at, check_out_at, status, admin_note } = req.body;
  if (!user_id || !date) return res.status(400).json({ error: 'user_id and date required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO attendance
         (user_id, date, check_in_at, check_out_at, status,
          check_in_type, check_out_type, approval_status, approved_by, approved_at, admin_note)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,'approved',$7,NOW(),$8)
       ON CONFLICT (user_id, date) DO UPDATE
         SET check_in_at = $3, check_out_at = $4, status = $5,
             check_in_type = 'manual', check_out_type = $6,
             approval_status = 'approved', approved_by = $7, approved_at = NOW(), admin_note = $8
       RETURNING *`,
      [user_id, date, check_in_at || null, check_out_at || null, status || 'present',
       check_out_at ? 'manual' : null, req.user.id, admin_note || null]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/attendance/toggle/:userId — admin toggles attendance_enabled
router.put('/toggle/:userId', auth, adminOnly, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE users SET attendance_enabled = $1
       WHERE id = $2 AND role = 'employee'
       RETURNING id, name, attendance_enabled`,
      [enabled, req.params.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

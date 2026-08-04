const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

const LOG_SELECT = `
  SELECT l.*,
    u.name       AS user_name,
    t.code       AS task_code,
    t.title      AS task_title,
    t.company    AS task_company,
    t.status     AS task_status
  FROM daily_logs l
  LEFT JOIN users u ON u.id  = l.user_id
  LEFT JOIN tasks t ON t.id  = l.task_id
`;

// Get logs
router.get('/', auth, async (req, res) => {
  const { user_id, date, task_id } = req.query;
  const isAdmin = req.user.role === 'admin';

  const conds  = [];
  const params = [];

  if (!isAdmin) {
    params.push(req.user.id);
    conds.push(`l.user_id = $${params.length}`);
  } else if (user_id) {
    params.push(user_id);
    conds.push(`l.user_id = $${params.length}`);
  }

  if (date) {
    params.push(date);
    conds.push(`l.log_date = $${params.length}`);
  }

  if (task_id) {
    params.push(task_id);
    conds.push(`l.task_id = $${params.length}`);
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  try {
    const { rows } = await db.query(
      `${LOG_SELECT} ${where} ORDER BY l.log_date DESC, l.logged_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add log entry
router.post('/', auth, async (req, res) => {
  const { task_id, description, hours, status_after, log_date, ad_hoc_title } = req.body;
  if (!description?.trim()) return res.status(400).json({ error: 'Description is required' });

  try {
    if (task_id && status_after) {
      const { rows } = await db.query('SELECT assignee_id FROM tasks WHERE id=$1', [task_id]);
      if (rows[0] && (req.user.role === 'admin' || rows[0].assignee_id === req.user.id)) {
        await db.query(
          'UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2',
          [status_after, task_id]
        );
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `INSERT INTO daily_logs (user_id, task_id, log_date, description, hours, status_after, ad_hoc_title)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.id, task_id || null, log_date || today,
       description.trim(), hours || null, status_after || null,
       (!task_id && ad_hoc_title?.trim()) ? ad_hoc_title.trim() : null]
    );

    const { rows: full } = await db.query(
      `${LOG_SELECT} WHERE l.id=$1`,
      [rows[0].id]
    );
    res.status(201).json(full[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Who has/hasn't logged today — for admin dashboard
router.get('/today-summary', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { company } = req.query;
  const today = new Date().toISOString().slice(0, 10);

  const empCf  = (company && company !== 'ALL') ? `AND u.company = '${company}'` : '';

  try {
    const { rows } = await db.query(
      `SELECT
         u.id, u.name, u.company, u.department,
         EXISTS(
           SELECT 1 FROM daily_logs l WHERE l.user_id=u.id AND l.log_date=$1
         ) AS has_logged,
         (SELECT COALESCE(SUM(l.hours),0) FROM daily_logs l WHERE l.user_id=u.id AND l.log_date=$1) AS total_hours
       FROM users u
       WHERE u.role='employee' AND u.active=true ${empCf}
       ORDER BY u.company, u.name`,
      [today]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

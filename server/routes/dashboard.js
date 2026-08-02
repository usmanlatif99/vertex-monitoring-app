const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

router.get('/stats', auth, adminOnly, async (req, res) => {
  const { company } = req.query;
  const today = new Date().toISOString().slice(0, 10);

  const cf     = (company && company !== 'ALL') ? `AND t.company = '${company}'` : '';
  const empCf  = (company && company !== 'ALL') ? `AND u.company = '${company}'` : '';

  try {
    const { rows: taskStats } = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE t.status NOT IN ('completed','cancelled') ${cf}) AS active,
        COUNT(*) FILTER (WHERE t.status = 'completed' ${cf})                    AS completed,
        COUNT(*) FILTER (WHERE t.status = 'blocked' ${cf})                      AS blocked,
        COUNT(*) FILTER (
          WHERE t.due_date < $1 AND t.status NOT IN ('completed','cancelled') ${cf}
        ) AS overdue,
        COUNT(*) FILTER (
          WHERE t.due_date BETWEEN $1 AND $1::date + 7
            AND t.status NOT IN ('completed','cancelled') ${cf}
        ) AS due_this_week
       FROM tasks t`,
      [today]
    );

    const { rows: empStats } = await db.query(
      `SELECT
         COUNT(DISTINCT u.id)      AS total_employees,
         COUNT(DISTINCT l.user_id) AS logged_today
       FROM users u
       LEFT JOIN daily_logs l ON l.user_id = u.id AND l.log_date = $1
       WHERE u.role = 'employee' AND u.active = true ${empCf}`,
      [today]
    );

    res.json({ tasks: taskStats[0], employees: empStats[0], date: today });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

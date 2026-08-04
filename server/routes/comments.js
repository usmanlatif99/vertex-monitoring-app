const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  const { task_id } = req.query;
  if (!task_id) return res.status(400).json({ error: 'task_id required' });
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.name AS user_name, u.role AS user_role
       FROM task_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [task_id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', auth, async (req, res) => {
  const { task_id, text, parent_id } = req.body;
  if (!task_id || !text?.trim()) {
    return res.status(400).json({ error: 'task_id and text are required' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO task_comments (task_id, user_id, text, parent_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *,
         (SELECT name FROM users WHERE id=$2) AS user_name,
         (SELECT role FROM users WHERE id=$2) AS user_role`,
      [task_id, req.user.id, text.trim(), parent_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

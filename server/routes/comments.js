const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  const { task_id } = req.query;
  if (!task_id) return res.status(400).json({ error: 'task_id required' });
  try {
    const { rows: comments } = await db.query(
      `SELECT c.*, u.name AS user_name, u.role AS user_role
       FROM task_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [task_id]
    );

    if (comments.length) {
      const ids = comments.map(c => c.id);
      const { rows: atts } = await db.query(
        `SELECT a.*, u.name AS uploader_name
         FROM task_attachments a
         JOIN users u ON u.id = a.uploaded_by
         WHERE a.comment_id = ANY($1::int[])`,
        [ids]
      );
      const attMap = {};
      atts.forEach(a => { (attMap[a.comment_id] = attMap[a.comment_id] || []).push(a); });
      comments.forEach(c => { c.attachments = attMap[c.id] || []; });
    }

    res.json(comments);
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
    res.status(201).json({ ...rows[0], attachments: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

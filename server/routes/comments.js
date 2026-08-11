const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const email  = require('../email');
const push   = require('../push');

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

    // Fire-and-forget: notify relevant parties about the new comment
    (async () => {
      try {
        const { rows: taskRows } = await db.query(
          `SELECT t.id, t.code, t.title, t.assignee_id,
                  u.email AS assignee_email, u.name AS assignee_name
           FROM tasks t JOIN users u ON u.id = t.assignee_id
           WHERE t.id = $1`,
          [task_id]
        );
        if (!taskRows[0]) return;
        const task = taskRows[0];
        const commenter = req.user;
        const { rows: admins } = await db.query(
          "SELECT id, email FROM users WHERE role='admin' AND active=true"
        );
        const { rows: collabs } = await db.query(
          `SELECT u.id, u.email FROM task_collaborators tc
           JOIN users u ON u.id = tc.user_id WHERE tc.task_id = $1`,
          [task_id]
        );
        const collabEmails = collabs.filter(c => c.id !== commenter.id).map(c => c.email);

        let recipientEmails = [];
        if (commenter.role === 'employee') {
          // employee comment → notify admins + collaborators
          const adminEmails = admins.filter(a => a.id !== commenter.id).map(a => a.email);
          recipientEmails = [...new Set([...adminEmails, ...collabEmails])];
        } else {
          // admin comment → notify assignee (if not commenter) + collaborators
          const toNotify = [];
          if (task.assignee_id !== commenter.id) toNotify.push(task.assignee_email);
          recipientEmails = [...new Set([...toNotify, ...collabEmails])];
        }

        if (recipientEmails.length) {
          await email.newComment(task, commenter.name, rows[0].text, recipientEmails);
        }

        // Push notifications
        const pushPayload = {
          title: `[${task.code}] New comment`,
          body:  `${commenter.name}: ${rows[0].text.slice(0, 80)}`,
        };
        if (commenter.role === 'employee') {
          await push.toAdmins(pushPayload, commenter.id);
        } else {
          if (task.assignee_id !== commenter.id) await push.toUser(task.assignee_id, pushPayload);
        }
        for (const c of collabs) {
          if (c.id !== commenter.id) await push.toUser(c.id, pushPayload);
        }
      } catch (e) { console.error('[notify]', e.message); }
    })();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

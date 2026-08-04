const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const email  = require('../email');
const push   = require('../push');

const TASK_SELECT = `
  SELECT t.*,
    u.name       AS assignee_name,
    u.department AS assignee_dept,
    cb.name      AS created_by_name,
    COALESCE(
      json_agg(o ORDER BY o.sort_order) FILTER (WHERE o.id IS NOT NULL), '[]'
    ) AS objectives
  FROM tasks t
  LEFT JOIN users u  ON u.id  = t.assignee_id
  LEFT JOIN users cb ON cb.id = t.created_by
  LEFT JOIN objectives o ON o.task_id = t.id
`;

// List tasks
router.get('/', auth, async (req, res) => {
  const { company, status, assignee_id } = req.query;
  const isAdmin = req.user.role === 'admin';

  const conds  = [];
  const params = [];

  if (!isAdmin) {
    params.push(req.user.id);
    conds.push(`t.assignee_id = $${params.length}`);
  } else if (assignee_id) {
    params.push(assignee_id);
    conds.push(`t.assignee_id = $${params.length}`);
  }

  if (company && company !== 'ALL') {
    params.push(company);
    conds.push(`t.company = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conds.push(`t.status = $${params.length}`);
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  try {
    const { rows } = await db.query(
      `${TASK_SELECT} ${where}
       GROUP BY t.id, u.name, u.department, cb.name
       ORDER BY
         CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         t.due_date ASC NULLS LAST,
         t.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single task
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `${TASK_SELECT} WHERE t.id = $1
       GROUP BY t.id, u.name, u.department, cb.name`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    if (req.user.role !== 'admin' && rows[0].assignee_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create task (admin only)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { title, description, company, assignee_id, priority, due_date, objectives } = req.body;
  if (!title || !company || !assignee_id) {
    return res.status(400).json({ error: 'title, company, and assignee_id are required' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: seqRows } = await client.query(
      `INSERT INTO task_sequences (company, last_seq) VALUES ($1, 1)
       ON CONFLICT (company) DO UPDATE SET last_seq = task_sequences.last_seq + 1
       RETURNING last_seq`,
      [company]
    );
    const code = `${company}-${String(seqRows[0].last_seq).padStart(4, '0')}`;

    const { rows: taskRows } = await client.query(
      `INSERT INTO tasks (code, title, description, company, assignee_id, created_by, priority, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [code, title.trim(), description?.trim() || null, company,
       assignee_id, req.user.id, priority || 'medium', due_date || null]
    );
    const taskId = taskRows[0].id;

    if (Array.isArray(objectives) && objectives.length) {
      for (let i = 0; i < objectives.length; i++) {
        const text = typeof objectives[i] === 'string' ? objectives[i] : objectives[i].text;
        if (text?.trim()) {
          await client.query(
            'INSERT INTO objectives (task_id, text, sort_order) VALUES ($1,$2,$3)',
            [taskId, text.trim(), i]
          );
        }
      }
    }

    await client.query('COMMIT');

    const { rows } = await client.query(
      `${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id, u.name, u.department, cb.name`,
      [taskId]
    );
    res.status(201).json(rows[0]);

    // Fire-and-forget: notify the assignee
    const { rows: assigneeRows } = await db.query('SELECT email FROM users WHERE id=$1', [assignee_id]);
    if (assigneeRows[0]) {
      email.taskAssigned(rows[0], assigneeRows[0].email).catch(e => console.error('[email]', e.message));
    }
    push.toUser(assignee_id, {
      title: 'New task assigned',
      body:  `${rows[0].code}: ${rows[0].title}`,
    }).catch(e => console.error('[push]', e.message));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Update task
router.put('/:id', auth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { title, description, priority, due_date, status, assignee_id } = req.body;

  try {
    // Fetch current task state (needed for access check + status-change email)
    const { rows: cur } = await db.query('SELECT assignee_id, status FROM tasks WHERE id=$1', [req.params.id]);
    if (!cur[0]) return res.status(404).json({ error: 'Task not found' });
    const oldStatus = cur[0].status;

    if (!isAdmin) {
      // Employees can only change status of their own tasks
      if (cur[0].assignee_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
      if (status) await db.query(
        'UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]
      );
    } else {
      const cols = [];
      const vals = [];
      const add  = (col, val) => { vals.push(val); cols.push(`${col}=$${vals.length}`); };

      if (title)                   add('title',       title.trim());
      if (description !== undefined) add('description', description?.trim() || null);
      if (priority)                add('priority',    priority);
      if (due_date !== undefined)  add('due_date',    due_date || null);
      if (status)                  add('status',      status);
      if (assignee_id)             add('assignee_id', assignee_id);

      if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });
      cols.push('updated_at=NOW()');
      vals.push(req.params.id);
      await db.query(`UPDATE tasks SET ${cols.join(',')} WHERE id=$${vals.length}`, vals);
    }

    const { rows } = await db.query(
      `${TASK_SELECT} WHERE t.id=$1 GROUP BY t.id, u.name, u.department, cb.name`,
      [req.params.id]
    );
    res.json(rows[0]);

    // Fire-and-forget: notify admins when status changes
    if (status && status !== oldStatus) {
      (async () => {
        try {
          const { rows: admins } = await db.query(
            "SELECT email FROM users WHERE role='admin' AND active=true AND id != $1",
            [req.user.id]
          );
          await email.statusChanged(rows[0], oldStatus, status, req.user.name, admins.map(a => a.email));
          await push.toAdmins({
            title: `[${rows[0].code}] Status updated`,
            body:  `${req.user.name} → ${status.replace('_', ' ')}`,
          }, req.user.id);
        } catch (e) { console.error('[notify]', e.message); }
      })();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle objective
router.put('/:id/objectives/:objId', auth, async (req, res) => {
  const { done } = req.body;
  try {
    const { rows: tRows } = await db.query('SELECT assignee_id, status FROM tasks WHERE id=$1', [req.params.id]);
    if (!tRows[0]) return res.status(404).json({ error: 'Task not found' });
    if (req.user.role !== 'admin' && tRows[0].assignee_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows } = await db.query(
      'UPDATE objectives SET done=$1 WHERE id=$2 AND task_id=$3 RETURNING *',
      [done, req.params.objId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Objective not found' });

    // Auto-update task status based on objectives completion
    const { rows: allObjs } = await db.query(
      'SELECT done FROM objectives WHERE task_id=$1', [req.params.id]
    );
    const allDone = allObjs.length > 0 && allObjs.every(o => o.done);
    if (allDone) {
      await db.query('UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2', ['completed', req.params.id]);
    } else if (tRows[0].status === 'completed') {
      await db.query('UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2', ['in_progress', req.params.id]);
    }

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

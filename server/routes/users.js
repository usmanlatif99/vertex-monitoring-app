const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const auth   = require('../middleware/auth');

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

// List all users
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, role, company, department, active, created_at
       FROM users ORDER BY company, name`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user
router.post('/', auth, adminOnly, async (req, res) => {
  const { name, email, password, role, company, department } = req.body;
  if (!name || !email || !password || !role || !company) {
    return res.status(400).json({ error: 'name, email, password, role, company are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, company, department, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6, true)
       RETURNING id, name, email, role, company, department, active, must_change_password`,
      [name.trim(), email.toLowerCase().trim(), hash, role, company, department || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user
router.put('/:id', auth, adminOnly, async (req, res) => {
  const { name, email, role, company, department, active, password } = req.body;
  try {
    const params = [name, email?.toLowerCase().trim(), role, company, department ?? null, active, req.params.id];
    let q = `UPDATE users SET name=$1, email=$2, role=$3, company=$4, department=$5, active=$6 WHERE id=$7
             RETURNING id, name, email, role, company, department, active`;

    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const hash = await bcrypt.hash(password, 10);
      params.splice(6, 0, hash);
      q = `UPDATE users SET name=$1, email=$2, role=$3, company=$4, department=$5, active=$6, password_hash=$7
           WHERE id=$8 RETURNING id, name, email, role, company, department, active`;
    }

    const { rows } = await db.query(q, params);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change own password
router.put('/me/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!await bcrypt.compare(current_password, rows[0].password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

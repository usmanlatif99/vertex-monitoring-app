const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const auth    = require('../middleware/auth');
const email   = require('../email');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email = $1 AND active = true',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role, company: user.company, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    const { password_hash: _, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, email, role, company, department, must_change_password, attendance_enabled, guarantee_access FROM users WHERE id = $1 AND active = true',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/force-change-password', auth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2',
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Forgot password — always returns 200 to prevent email enumeration
router.post('/forgot-password', async (req, res) => {
  res.json({ ok: true });
  const { email: userEmail } = req.body;
  if (!userEmail) return;
  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email=$1 AND active=true',
      [userEmail.toLowerCase().trim()]
    );
    if (!rows[0]) return;
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000);
    await db.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [rows[0].id, token, expires]
    );
    const resetUrl = `${process.env.APP_URL || 'https://tasks.vertex.pk'}/#reset-${token}`;
    await email.passwordReset(rows[0], resetUrl);
  } catch (e) { console.error('[forgot-password]', e.message); }
});

// Reset password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    const { rows } = await db.query(
      'SELECT * FROM password_reset_tokens WHERE token=$1 AND used=false AND expires_at > NOW()',
      [token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
    await db.query('UPDATE password_reset_tokens SET used=true WHERE id=$1', [rows[0].id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[reset-password]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

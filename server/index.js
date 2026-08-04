require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const cron      = require('node-cron');
const db        = require('./db');
const email     = require('./email');

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Tighter rate limit on login
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many login attempts — try again later' },
}));

// General API rate limit
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { error: 'Too many requests' },
}));

// API routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/tasks',     require('./routes/tasks'));
app.use('/api/logs',      require('./routes/logs'));
app.use('/api/comments',     require('./routes/comments'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/attachments',  require('./routes/attachments'));
app.use('/api/push',         require('./routes/push'));

// Serve frontend
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ── Startup initialization ────────────────────────────────────────────────────
async function initialize() {
  // Create schema
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Schema ready');

  // Create default admin if no users exist
  const { rows } = await db.query('SELECT id FROM users LIMIT 1');
  if (!rows.length) {
    const email    = process.env.ADMIN_EMAIL    || 'admin@vv.local';
    const name     = process.env.ADMIN_NAME     || 'Admin';
    const password = process.env.ADMIN_PASSWORD || 'Admin@123';
    const hash     = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO users (name, email, password_hash, role, company, department)
       VALUES ($1,$2,$3,'admin','ALL','Management')`,
      [name, email, hash]
    );
    console.log(`Default admin created → ${email} / ${password}`);
    console.log('Change this password immediately after first login!');
  }
}

// ── Daily overdue digest — 8:00 AM PKT (03:00 UTC) ───────────────────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: tasks } = await db.query(
      `SELECT t.code, t.title, t.due_date, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.due_date < $1 AND t.status NOT IN ('completed','cancelled')
       ORDER BY t.due_date ASC`,
      [today]
    );
    const { rows: admins } = await db.query(
      "SELECT email FROM users WHERE role='admin' AND active=true"
    );
    await email.overdueDigest(tasks, admins.map(a => a.email));
  } catch (e) {
    console.error('[cron] Overdue digest failed:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
initialize()
  .then(() => app.listen(PORT, () => console.log(`V·V TaskLog running on :${PORT}`)))
  .catch(err => { console.error('Startup failed', err); process.exit(1); });

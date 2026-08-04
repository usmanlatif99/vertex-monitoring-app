const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const auth    = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIME.has(file.mimetype) ? cb(null, true) : cb(new Error('File type not allowed'));
  },
});

// List attachments for a task
router.get('/task/:taskId', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, u.name AS uploader_name
       FROM task_attachments a
       JOIN users u ON u.id = a.uploaded_by
       WHERE a.task_id = $1 AND a.comment_id IS NULL
       ORDER BY a.uploaded_at DESC`,
      [req.params.taskId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload attachment
router.post('/task/:taskId', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const { rows } = await db.query(
      `INSERT INTO task_attachments (task_id, uploaded_by, original_name, stored_name, mime_type, file_size)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.params.taskId, req.user.id, req.file.originalname,
       req.file.filename, req.file.mimetype, req.file.size]
    );
    const { rows: full } = await db.query(
      `SELECT a.*, u.name AS uploader_name
       FROM task_attachments a JOIN users u ON u.id = a.uploaded_by
       WHERE a.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(full[0]);
  } catch (e) {
    fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload attachment linked to a comment
router.post('/comment/:commentId', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const { rows: cr } = await db.query(
      'SELECT task_id FROM task_comments WHERE id = $1',
      [req.params.commentId]
    );
    if (!cr.length) {
      fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
      return res.status(404).json({ error: 'Comment not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO task_attachments (task_id, comment_id, uploaded_by, original_name, stored_name, mime_type, file_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [cr[0].task_id, req.params.commentId, req.user.id,
       req.file.originalname, req.file.filename, req.file.mimetype, req.file.size]
    );
    const { rows: full } = await db.query(
      `SELECT a.*, u.name AS uploader_name
       FROM task_attachments a JOIN users u ON u.id = a.uploaded_by
       WHERE a.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(full[0]);
  } catch (e) {
    fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Download attachment
router.get('/:id/download', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM task_attachments WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(UPLOAD_DIR, rows[0].stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.download(filePath, rows[0].original_name);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete attachment — admin or the uploader
router.delete('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM task_attachments WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const att = rows[0];
    if (req.user.role !== 'admin' && att.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    await db.query('DELETE FROM task_attachments WHERE id = $1', [req.params.id]);
    fs.unlink(path.join(UPLOAD_DIR, att.stored_name), () => {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large — maximum 20 MB' });
  res.status(400).json({ error: err.message || 'Upload error' });
});

module.exports = router;

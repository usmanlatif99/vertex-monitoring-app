'use strict';
const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const ORIGIN  = (process.env.APP_URL || 'https://tasks.vertex.pk').replace(/\/$/, '');
const RP_ID   = new URL(ORIGIN).hostname;
const RP_NAME = 'VE WorkLog';

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

async function cleanChallenges() {
  await db.query("DELETE FROM webauthn_challenges WHERE expires_at < NOW()").catch(() => {});
}

// ── Employee: get own device status ──────────────────────────────────────────
router.get('/device', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, device_name, browser_info, status, registered_at, revocation_reason
       FROM attendance_credentials WHERE user_id = $1
       ORDER BY registered_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Employee: start device registration ──────────────────────────────────────
router.post('/register/options', auth, async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      `SELECT id, status FROM attendance_credentials
       WHERE user_id = $1 AND status IN ('pending','approved') LIMIT 1`,
      [req.user.id]
    );
    if (existing[0]) {
      return res.status(409).json({
        error: existing[0].status === 'pending'
          ? 'A device registration is already pending admin approval.'
          : 'You already have an approved device. Ask admin to revoke it before registering a new one.',
      });
    }

    const { rows: uRows } = await db.query(
      'SELECT id, name, email FROM users WHERE id = $1', [req.user.id]
    );
    const user = uRows[0];

    const options = generateRegistrationOptions({
      rpName: RP_NAME,
      rpID:   RP_ID,
      userID: String(user.id),
      userName: user.email,
      userDisplayName: user.name,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 300000,
    });

    await db.query(
      `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at)
       VALUES ($1, $2, 'registration', NOW() + INTERVAL '5 minutes')
       ON CONFLICT (challenge) DO NOTHING`,
      [req.user.id, options.challenge]
    );

    res.json(options);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Employee: complete device registration ────────────────────────────────────
router.post('/register/verify', auth, async (req, res) => {
  const { response, deviceName } = req.body;
  try {
    await cleanChallenges();
    const { rows: chalRows } = await db.query(
      `SELECT id, challenge FROM webauthn_challenges
       WHERE user_id = $1 AND purpose = 'registration'
         AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!chalRows[0]) {
      return res.status(400).json({ error: 'Registration challenge expired. Please try again.' });
    }
    const { id: chalId, challenge } = chalRows[0];

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin:    ORIGIN,
      expectedRPID:      RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Biometric verification failed. Please try again.' });
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    const credIdStr  = Buffer.isBuffer(credentialID)
      ? credentialID.toString('base64url')
      : Buffer.from(credentialID).toString('base64url');
    const pubKeyStr  = Buffer.isBuffer(credentialPublicKey)
      ? credentialPublicKey.toString('base64url')
      : Buffer.from(credentialPublicKey).toString('base64url');
    const transports = response.response?.transports || [];
    const browserInfo = (req.headers['user-agent'] || '').slice(0, 500);

    await db.query('UPDATE webauthn_challenges SET consumed_at = NOW() WHERE id = $1', [chalId]);

    const { rows } = await db.query(
      `INSERT INTO attendance_credentials
         (user_id, credential_id, public_key, counter, transports, device_name, browser_info, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       RETURNING id, device_name, status, registered_at`,
      [req.user.id, credIdStr, pubKeyStr, counter, transports,
       deviceName || 'My Phone', browserInfo]
    );

    res.json({ ok: true, credential: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || 'Verification failed' }); }
});

// ── Employee: get auth challenge for check-in/checkout ────────────────────────
router.post('/auth/options', auth, async (req, res) => {
  const { action } = req.body;
  if (!['checkin', 'checkout'].includes(action)) {
    return res.status(400).json({ error: 'action must be checkin or checkout' });
  }
  try {
    const { rows: credRows } = await db.query(
      `SELECT credential_id, transports FROM attendance_credentials
       WHERE user_id = $1 AND status = 'approved' LIMIT 1`,
      [req.user.id]
    );
    if (!credRows[0]) {
      return res.status(403).json({ error: 'No approved device found. Contact admin.' });
    }

    const options = generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: [{
        id: Buffer.from(credRows[0].credential_id, 'base64url'),
        type: 'public-key',
        transports: credRows[0].transports || [],
      }],
      timeout: 300000,
    });

    await db.query(
      `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')
       ON CONFLICT (challenge) DO NOTHING`,
      [req.user.id, options.challenge, action]
    );

    res.json(options);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Employee: request device replacement ─────────────────────────────────────
router.post('/device/replace', auth, async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) {
    return res.status(400).json({ error: 'Reason is required for device replacement' });
  }
  try {
    await db.query(
      `UPDATE attendance_credentials
       SET status = 'revoked', revoked_at = NOW(), revocation_reason = $1
       WHERE user_id = $2 AND status IN ('approved','pending')`,
      [reason.trim(), req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: list all device registrations ─────────────────────────────────────
router.get('/admin/devices', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ac.id, ac.device_name, ac.browser_info, ac.status,
              ac.registered_at, ac.approved_at, ac.revoked_at, ac.revocation_reason,
              u.id AS user_id, u.name AS user_name, u.email, u.department, u.company,
              ab.name AS approved_by_name
       FROM attendance_credentials ac
       JOIN  users u  ON u.id  = ac.user_id
       LEFT JOIN users ab ON ab.id = ac.approved_by
       ORDER BY
         CASE ac.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         ac.registered_at DESC`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: approve a credential ───────────────────────────────────────────────
router.put('/admin/devices/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const { rows: target } = await db.query(
      'SELECT user_id FROM attendance_credentials WHERE id = $1', [req.params.id]
    );
    if (!target[0]) return res.status(404).json({ error: 'Credential not found' });

    // Revoke any other active credential for same employee
    await db.query(
      `UPDATE attendance_credentials
       SET status = 'revoked', revoked_at = NOW(), revocation_reason = 'Replaced by new device'
       WHERE user_id = $1 AND status = 'approved' AND id != $2`,
      [target[0].user_id, req.params.id]
    );

    const { rows } = await db.query(
      `UPDATE attendance_credentials
       SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2 RETURNING id, status`,
      [req.user.id, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: reject a credential ────────────────────────────────────────────────
router.put('/admin/devices/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE attendance_credentials
       SET status = 'rejected', revoked_at = NOW(), revocation_reason = $1
       WHERE id = $2 RETURNING id, status`,
      [reason || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Credential not found' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: revoke an approved credential ──────────────────────────────────────
router.put('/admin/devices/:id/revoke', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });
  try {
    const { rows } = await db.query(
      `UPDATE attendance_credentials
       SET status = 'revoked', revoked_at = NOW(), revocation_reason = $1
       WHERE id = $2 RETURNING id, status`,
      [reason.trim(), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Credential not found' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Exported helper: verify a WebAuthn assertion (used by attendance route) ───
async function verifyAssertion(userId, assertion, action) {
  await cleanChallenges();

  const { rows: chalRows } = await db.query(
    `SELECT id, challenge FROM webauthn_challenges
     WHERE user_id = $1 AND purpose = $2
       AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY expires_at DESC LIMIT 1`,
    [userId, action]
  );
  if (!chalRows[0]) throw new Error('Authentication challenge expired. Please try again.');

  const { rows: credRows } = await db.query(
    `SELECT id, credential_id, public_key, counter, transports
     FROM attendance_credentials WHERE user_id = $1 AND status = 'approved' LIMIT 1`,
    [userId]
  );
  if (!credRows[0]) throw new Error('No approved device. Contact admin.');

  const cred = credRows[0];
  const verification = await verifyAuthenticationResponse({
    response:          assertion,
    expectedChallenge: chalRows[0].challenge,
    expectedOrigin:    ORIGIN,
    expectedRPID:      RP_ID,
    authenticator: {
      credentialID:        Buffer.from(cred.credential_id, 'base64url'),
      credentialPublicKey: Buffer.from(cred.public_key,    'base64url'),
      counter:             cred.counter,
      transports:          cred.transports || [],
    },
    requireUserVerification: true,
  });

  if (!verification.verified) throw new Error('Biometric verification failed. Please try again.');

  await db.query('UPDATE webauthn_challenges SET consumed_at = NOW() WHERE id = $1', [chalRows[0].id]);
  await db.query('UPDATE attendance_credentials SET counter = $1 WHERE id = $2',
    [verification.authenticationInfo.newCounter, cred.id]);

  return { credentialDbId: cred.id };
}

module.exports = router;
module.exports.verifyAssertion = verifyAssertion;

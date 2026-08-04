'use strict';
const webpush = require('web-push');
const db      = require('./db');

const APP_URL = () => process.env.APP_URL || 'https://tasks.vertex.pk';

function setup() {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    webpush.setVapidDetails(
      `mailto:${process.env.SMTP_USER || 'admin@vertex.pk'}`,
      pub,
      priv
    );
  }
}
setup();

async function deliver(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    console.log('[push] sent to user_id:', sub.user_id);
  } catch (e) {
    console.error('[push] deliver failed — status:', e.statusCode, 'message:', e.message);
    if (e.statusCode === 410 || e.statusCode === 404) {
      await db.query('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]);
    }
  }
}

// Send to a specific user (all their devices)
async function toUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { rows } = await db.query(
      'SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]
    );
    for (const sub of rows) await deliver(sub, { url: APP_URL(), ...payload });
  } catch (e) { console.error('[push] toUser:', e.message); }
}

// Send to all admins, optionally excluding one user
async function toAdmins(payload, excludeUserId) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const q = excludeUserId
      ? `SELECT ps.* FROM push_subscriptions ps
         JOIN users u ON u.id=ps.user_id
         WHERE u.role='admin' AND u.active=true AND u.id!=$1`
      : `SELECT ps.* FROM push_subscriptions ps
         JOIN users u ON u.id=ps.user_id
         WHERE u.role='admin' AND u.active=true`;
    const { rows } = await db.query(q, excludeUserId ? [excludeUserId] : []);
    for (const sub of rows) await deliver(sub, { url: APP_URL(), ...payload });
  } catch (e) { console.error('[push] toAdmins:', e.message); }
}

module.exports = { toUser, toAdmins };

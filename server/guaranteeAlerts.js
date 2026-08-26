'use strict';

const db = require('./db');
const email = require('./email');

async function sendGuaranteeExpiryAlerts() {
  const { rows: guarantees } = await db.query(`
    SELECT id, guarantee_no, issuing_bank, beneficiary, guarantee_type, amount,
           current_expiry_date, (current_expiry_date - CURRENT_DATE)::int AS remaining_days
    FROM bank_guarantees
    WHERE deleted_at IS NULL AND lifecycle_status='active'
      AND current_expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 2
    ORDER BY current_expiry_date, beneficiary`);

  if (!guarantees.length) return { guarantees: 0, recipients: 0 };

  const { rows: recipients } = await db.query(`
    SELECT DISTINCT email
    FROM users
    WHERE active=true AND email IS NOT NULL
      AND (role='admin' OR guarantee_access IN ('editor','administrator'))`);
  const emails = recipients.map(r => r.email).filter(Boolean);
  if (!emails.length) return { guarantees: guarantees.length, recipients: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const unsent = [];
  for (const guarantee of guarantees) {
    const { rowCount } = await db.query(
      `INSERT INTO guarantee_alerts (guarantee_id, alert_date, alert_type, recipients)
       VALUES ($1,$2,'expiry_2_day',$3)
       ON CONFLICT (guarantee_id, alert_date, alert_type) DO NOTHING`,
      [guarantee.id, today, emails.join(',')]
    );
    if (rowCount) unsent.push(guarantee);
  }

  if (unsent.length) await email.guaranteeExpiryDigest(unsent, emails);
  return { guarantees: unsent.length, recipients: emails.length };
}

module.exports = { sendGuaranteeExpiryAlerts };

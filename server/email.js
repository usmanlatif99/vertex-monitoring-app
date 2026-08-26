'use strict';
const nodemailer = require('nodemailer');

const enabled = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function makeTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const FROM    = () => `VE WorkLog <${process.env.SMTP_FROM || process.env.SMTP_USER}>`;
const APP_URL = () => process.env.APP_URL || 'https://tasks.vertex.pk';

async function send(to, subject, html) {
  if (!enabled()) return;
  try {
    await makeTransport().sendMail({ from: FROM(), to, subject, html });
    console.log('[email] →', to, '|', subject);
  } catch (e) {
    console.error('[email] Failed to send to', to, ':', e.message);
  }
}

const ST_LABEL = {
  in_progress: 'In Progress', not_started: 'Not Started',
  blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled',
};

// ── Layout helpers ─────────────────────────────────────────────────────────────

function shell(content) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f0f4f8;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:#1a2840;padding:18px 28px">
      <span style="color:#fff;font-weight:700;font-size:17px">VE WorkLog</span>
    </div>
    <div style="padding:28px 28px 20px">${content}</div>
    <div style="padding:12px 28px;background:#f7f9fc;border-top:1px solid #dde3ec;color:#6b7a90;font-size:12px">
      VE WorkLog &middot; Task Monitoring &middot; Vertex Electronics &amp; Vision Engineering
    </div>
  </div>
</body></html>`;
}

function btn() {
  return `<a href="${APP_URL()}" style="display:inline-block;margin-top:18px;background:#1a8cd8;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Open VE WorkLog →</a>`;
}

function taskRow(label, value) {
  return `<tr>
    <td style="padding:7px 0;color:#6b7a90;font-size:13px;width:90px;vertical-align:top">${label}</td>
    <td style="padding:7px 0;font-size:14px">${value}</td>
  </tr>`;
}

// ── Email senders ──────────────────────────────────────────────────────────────

module.exports = {

  async taskAssigned(task, assigneeEmail) {
    const rows = [
      taskRow('Task',     `<strong>${task.code}</strong> — ${task.title}`),
      taskRow('Priority', task.priority ? task.priority[0].toUpperCase() + task.priority.slice(1) : '—'),
      taskRow('Deadline', task.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : 'Not set'),
    ];
    if (task.description) rows.push(taskRow('Details', task.description));

    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">New Task Assigned to You</h2>
      <p style="color:#6b7a90;margin:0 0 4px">You have been assigned a new task.</p>
      <table style="width:100%;border-collapse:collapse;margin:14px 0">${rows.join('')}</table>
      ${btn()}
    `);
    await send(assigneeEmail, `[${task.code}] New task assigned to you: ${task.title}`, html);
  },

  async newComment(task, commenterName, commentText, recipientEmails) {
    if (!recipientEmails.length) return;
    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">New Comment on Task</h2>
      <p style="margin:0 0 14px;color:#6b7a90">
        <strong style="color:#1a2332">${commenterName}</strong> commented on
        <strong>${task.code} — ${task.title}</strong>:
      </p>
      <blockquote style="margin:0 0 14px;padding:12px 16px;border-left:3px solid #1a8cd8;background:#f0f7fd;border-radius:0 6px 6px 0;color:#1a2332;font-size:14px">
        ${commentText}
      </blockquote>
      ${btn()}
    `);
    for (const email of recipientEmails) {
      await send(email, `[${task.code}] ${commenterName} commented on: ${task.title}`, html);
    }
  },

  async statusChanged(task, oldStatus, newStatus, changedByName, adminEmails) {
    if (!adminEmails.length) return;
    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">Task Status Updated</h2>
      <p style="margin:0 0 14px;color:#6b7a90">
        <strong style="color:#1a2332">${changedByName}</strong> updated the status of
        <strong>${task.code}</strong>:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:14px 0">
        ${taskRow('Task',        `<strong>${task.code}</strong> — ${task.title}`)}
        ${taskRow('Assigned to', task.assignee_name || '—')}
        ${taskRow('Status',
          `<span style="color:#6b7a90;text-decoration:line-through">${ST_LABEL[oldStatus] || oldStatus}</span>
           &nbsp;→&nbsp;
           <strong style="color:#1a8cd8">${ST_LABEL[newStatus] || newStatus}</strong>`
        )}
      </table>
      ${btn()}
    `);
    for (const email of adminEmails) {
      await send(email, `[${task.code}] Status → ${ST_LABEL[newStatus] || newStatus}: ${task.title}`, html);
    }
  },

  async collaboratorAdded(task, collabEmail) {
    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">You've Been Added as a Collaborator</h2>
      <p style="color:#6b7a90;margin:0 0 4px">You now have full access to collaborate on this task.</p>
      <table style="width:100%;border-collapse:collapse;margin:14px 0">
        ${taskRow('Task',     `<strong>${task.code}</strong> — ${task.title}`)}
        ${taskRow('Assignee', task.assignee_name || '—')}
        ${taskRow('Priority', task.priority ? task.priority[0].toUpperCase() + task.priority.slice(1) : '—')}
        ${taskRow('Deadline', task.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : 'Not set')}
      </table>
      ${btn()}
    `);
    await send(collabEmail, `[${task.code}] You've been added as a collaborator: ${task.title}`, html);
  },

  async passwordReset(user, resetUrl) {
    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">Reset Your Password</h2>
      <p style="color:#6b7a90;margin:0 0 14px">Hi <strong style="color:#1a2332">${user.name}</strong>, you requested a password reset for your VE WorkLog account.</p>
      <p style="color:#6b7a90;margin:0 0 18px">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#1a8cd8;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Reset Password →</a>
      <p style="color:#aab5c5;font-size:12px;margin-top:20px">If you didn't request this, you can safely ignore this email.</p>
    `);
    await send(user.email, 'Reset your VE WorkLog password', html);
  },

  async overdueDigest(overdueTasks, adminEmails) {
    if (!overdueTasks.length || !adminEmails.length) return;
    const rows = overdueTasks.map(t =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #dde3ec;font-family:monospace;font-size:12px;color:#7A4A00">${t.code}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde3ec;font-size:13px">${t.title}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde3ec;font-size:13px;color:#6b7a90">${t.assignee_name || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde3ec;font-size:13px;color:#dc3545;font-weight:600">${t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : '—'}</td>
      </tr>`
    ).join('');
    const count = overdueTasks.length;
    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">⚠ Overdue Tasks</h2>
      <p style="color:#6b7a90;margin:0 0 14px">${count} task${count > 1 ? 's are' : ' is'} past their deadline.</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #dde3ec;border-radius:6px;overflow:hidden">
        <thead>
          <tr style="background:#f7f9fc">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7a90;text-transform:uppercase;letter-spacing:.5px">Code</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7a90;text-transform:uppercase;letter-spacing:.5px">Task</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7a90;text-transform:uppercase;letter-spacing:.5px">Assigned to</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7a90;text-transform:uppercase;letter-spacing:.5px">Due date</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${btn()}
    `);
    for (const email of adminEmails) {
      await send(email, `⚠ ${count} overdue task${count > 1 ? 's' : ''}`, html);
    }
  },

  async guaranteeExpiryDigest(guarantees, recipientEmails) {
    if (!guarantees.length || !recipientEmails.length) return;
    const rows = guarantees.map(g => {
      const remaining = Number(g.remaining_days);
      const timing = remaining === 0 ? 'Expires today' : remaining === 1 ? '1 day remaining' : `${remaining} days remaining`;
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #dde3ec;font-size:12px;font-weight:600">${g.guarantee_no}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #dde3ec;font-size:12px">${g.beneficiary}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #dde3ec;font-size:12px">${g.issuing_bank}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #dde3ec;font-size:12px;color:#b45309;font-weight:600">${new Date(g.current_expiry_date).toISOString().slice(0,10)}<br>${timing}</td>
      </tr>`;
    }).join('');
    const html = shell(`
      <h2 style="margin:0 0 6px;color:#1a2332;font-size:17px">Bank Guarantee Expiry Alert</h2>
      <p style="color:#6b7a90;margin:0 0 14px">${guarantees.length} active guarantee${guarantees.length > 1 ? 's require' : ' requires'} attention within the next two days.</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #dde3ec">
        <thead><tr style="background:#f7f9fc"><th style="padding:8px 10px;text-align:left">Guarantee</th><th style="padding:8px 10px;text-align:left">Beneficiary</th><th style="padding:8px 10px;text-align:left">Bank</th><th style="padding:8px 10px;text-align:left">Expiry</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>${btn()}`);
    for (const recipient of recipientEmails) {
      await send(recipient, `⚠ ${guarantees.length} bank guarantee${guarantees.length > 1 ? 's' : ''} expiring soon`, html);
    }
  },
};

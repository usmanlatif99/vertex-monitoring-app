-- V·V TaskLog — Database Schema

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  email         VARCHAR(150)  UNIQUE NOT NULL,
  password_hash VARCHAR(255)  NOT NULL,
  role          VARCHAR(20)   NOT NULL DEFAULT 'employee',
  company       VARCHAR(10)   NOT NULL,
  department    VARCHAR(100),
  active        BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Atomic sequence counter per company for task codes
CREATE TABLE IF NOT EXISTS task_sequences (
  company  VARCHAR(10) PRIMARY KEY,
  last_seq INTEGER     NOT NULL DEFAULT 0
);
INSERT INTO task_sequences (company, last_seq) VALUES ('VTX', 0), ('VSN', 0)
  ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(20)  UNIQUE NOT NULL,
  title       VARCHAR(500) NOT NULL,
  description TEXT,
  company     VARCHAR(10)  NOT NULL,
  assignee_id INTEGER      NOT NULL REFERENCES users(id),
  created_by  INTEGER      NOT NULL REFERENCES users(id),
  priority    VARCHAR(20)  NOT NULL DEFAULT 'medium',
  status      VARCHAR(30)  NOT NULL DEFAULT 'not_started',
  due_date    DATE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS objectives (
  id         SERIAL  PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  done       BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_logs (
  id           SERIAL       PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id),
  task_id      INTEGER      REFERENCES tasks(id),
  log_date     DATE         NOT NULL DEFAULT CURRENT_DATE,
  description  TEXT         NOT NULL,
  hours        NUMERIC(4,1),
  status_after VARCHAR(30),
  logged_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_comments (
  id         SERIAL      PRIMARY KEY,
  task_id    INTEGER     NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id),
  text       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columns added after initial deploy
ALTER TABLE daily_logs       ADD COLUMN IF NOT EXISTS ad_hoc_title VARCHAR(200);
ALTER TABLE task_comments    ADD COLUMN IF NOT EXISTS parent_id   INTEGER REFERENCES task_comments(id);
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS archived              BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users            ADD COLUMN IF NOT EXISTS must_change_password  BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL      PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id            SERIAL       PRIMARY KEY,
  task_id       INTEGER      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploaded_by   INTEGER      NOT NULL REFERENCES users(id),
  original_name VARCHAR(500) NOT NULL,
  stored_name   VARCHAR(200) NOT NULL UNIQUE,
  mime_type     VARCHAR(100) NOT NULL,
  file_size     INTEGER      NOT NULL,
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS comment_id INTEGER REFERENCES task_comments(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL      PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT        NOT NULL UNIQUE,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_assignee   ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company    ON tasks(company);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_logs_user_date   ON daily_logs(user_id, log_date);
CREATE INDEX IF NOT EXISTS idx_logs_task        ON daily_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_task    ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON task_attachments(task_id);

-- Attendance module
ALTER TABLE users ADD COLUMN IF NOT EXISTS attendance_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS attendance (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  date            DATE    NOT NULL,
  check_in_at     TIMESTAMPTZ,
  check_out_at    TIMESTAMPTZ,
  check_in_lat    NUMERIC(10,7),
  check_in_lng    NUMERIC(10,7),
  check_out_lat   NUMERIC(10,7),
  check_out_lng   NUMERIC(10,7),
  status          VARCHAR(20) NOT NULL DEFAULT 'present',
  check_in_type   VARCHAR(20) NOT NULL DEFAULT 'location',
  check_out_type  VARCHAR(20),
  checkout_remark TEXT,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'approved',
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  admin_note      TEXT,
  UNIQUE(user_id, date)
);

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkin_remark TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS auto_checked_out BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance(user_id, date);
CREATE INDEX IF NOT EXISTS idx_att_date      ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_att_pending   ON attendance(approval_status) WHERE approval_status = 'pending';

-- WebAuthn device registration
CREATE TABLE IF NOT EXISTS attendance_credentials (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id     TEXT NOT NULL UNIQUE,
  public_key        TEXT NOT NULL,
  counter           INTEGER NOT NULL DEFAULT 0,
  transports        TEXT[] NOT NULL DEFAULT '{}',
  device_name       VARCHAR(200) NOT NULL DEFAULT 'My Phone',
  browser_info      VARCHAR(500),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by       INTEGER REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revocation_reason TEXT
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge   TEXT NOT NULL UNIQUE,
  purpose     VARCHAR(50) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS att_credential_id INTEGER REFERENCES attendance_credentials(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS verification_mode VARCHAR(20);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS gps_accuracy      NUMERIC(8,2);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS client_ip         VARCHAR(45);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS user_agent_str    TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS verified_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_att_creds_user ON attendance_credentials(user_id, status);
CREATE INDEX IF NOT EXISTS idx_webauthn_chal  ON webauthn_challenges(user_id, purpose) WHERE consumed_at IS NULL;

-- Task collaboration
CREATE TABLE IF NOT EXISTS task_collaborators (
  id       SERIAL      PRIMARY KEY,
  task_id  INTEGER     NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by INTEGER     NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_collab_task ON task_collaborators(task_id);
CREATE INDEX IF NOT EXISTS idx_collab_user ON task_collaborators(user_id);

-- Bank Guarantee Register
ALTER TABLE users ADD COLUMN IF NOT EXISTS guarantee_access VARCHAR(20) NOT NULL DEFAULT 'none';

CREATE TABLE IF NOT EXISTS guarantee_banks (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(150) NOT NULL UNIQUE,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guarantee_banks_name_ci ON guarantee_banks (LOWER(name));

CREATE TABLE IF NOT EXISTS bank_guarantees (
  id                   SERIAL PRIMARY KEY,
  company              VARCHAR(10) NOT NULL,
  guarantee_no         VARCHAR(120) NOT NULL,
  issuing_bank         VARCHAR(150) NOT NULL,
  bank_branch          VARCHAR(200),
  beneficiary          VARCHAR(250) NOT NULL,
  guarantee_type       VARCHAR(40) NOT NULL,
  issue_date           DATE NOT NULL,
  original_expiry_date DATE NOT NULL,
  current_expiry_date  DATE NOT NULL,
  amount               NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  cash_margin_percent  NUMERIC(7,3) CHECK (cash_margin_percent IS NULL OR (cash_margin_percent >= 0 AND cash_margin_percent <= 100)),
  cash_margin_amount   NUMERIC(18,2) CHECK (cash_margin_amount IS NULL OR cash_margin_amount >= 0),
  reference_no         VARCHAR(300),
  description          TEXT,
  lifecycle_status     VARCHAR(20) NOT NULL DEFAULT 'active',
  returned_date        DATE,
  responsible_user_id  INTEGER REFERENCES users(id),
  remarks              TEXT,
  created_by           INTEGER NOT NULL REFERENCES users(id),
  updated_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,
  deleted_by           INTEGER REFERENCES users(id),
  UNIQUE (issuing_bank, guarantee_no)
);

CREATE TABLE IF NOT EXISTS guarantee_extensions (
  id                   SERIAL PRIMARY KEY,
  guarantee_id         INTEGER NOT NULL REFERENCES bank_guarantees(id) ON DELETE CASCADE,
  previous_expiry_date DATE NOT NULL,
  new_expiry_date      DATE NOT NULL,
  amendment_no         VARCHAR(150),
  remarks              TEXT,
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (new_expiry_date >= previous_expiry_date)
);

CREATE TABLE IF NOT EXISTS guarantee_documents (
  id            SERIAL PRIMARY KEY,
  guarantee_id  INTEGER NOT NULL REFERENCES bank_guarantees(id) ON DELETE CASCADE,
  document_type VARCHAR(40) NOT NULL DEFAULT 'guarantee',
  original_name VARCHAR(500) NOT NULL,
  stored_name   VARCHAR(200) NOT NULL UNIQUE,
  mime_type     VARCHAR(100) NOT NULL,
  file_size     INTEGER NOT NULL,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guarantee_bank_limits (
  id               SERIAL PRIMARY KEY,
  company          VARCHAR(10) NOT NULL,
  issuing_bank     VARCHAR(150) NOT NULL,
  sanctioned_limit NUMERIC(18,2) NOT NULL CHECK (sanctioned_limit >= 0),
  notes            TEXT,
  updated_by       INTEGER NOT NULL REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company, issuing_bank)
);

-- Link existing text-based records to the controlled bank master without
-- breaking installations that already contain guarantee data.
ALTER TABLE bank_guarantees ADD COLUMN IF NOT EXISTS bank_id INTEGER REFERENCES guarantee_banks(id);
ALTER TABLE guarantee_bank_limits ADD COLUMN IF NOT EXISTS bank_id INTEGER REFERENCES guarantee_banks(id);
INSERT INTO guarantee_banks (name)
SELECT DISTINCT issuing_bank FROM bank_guarantees WHERE issuing_bank IS NOT NULL AND TRIM(issuing_bank) <> ''
ON CONFLICT DO NOTHING;
INSERT INTO guarantee_banks (name)
SELECT DISTINCT issuing_bank FROM guarantee_bank_limits WHERE issuing_bank IS NOT NULL AND TRIM(issuing_bank) <> ''
ON CONFLICT DO NOTHING;
UPDATE bank_guarantees g SET bank_id=b.id FROM guarantee_banks b
WHERE g.bank_id IS NULL AND LOWER(g.issuing_bank)=LOWER(b.name);
UPDATE guarantee_bank_limits l SET bank_id=b.id FROM guarantee_banks b
WHERE l.bank_id IS NULL AND LOWER(l.issuing_bank)=LOWER(b.name);

CREATE TABLE IF NOT EXISTS guarantee_alerts (
  id           SERIAL PRIMARY KEY,
  guarantee_id INTEGER NOT NULL REFERENCES bank_guarantees(id) ON DELETE CASCADE,
  alert_date   DATE NOT NULL,
  alert_type   VARCHAR(30) NOT NULL,
  recipients   TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guarantee_id, alert_date, alert_type)
);

CREATE TABLE IF NOT EXISTS guarantee_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  guarantee_id INTEGER REFERENCES bank_guarantees(id),
  action       VARCHAR(40) NOT NULL,
  changed_by   INTEGER NOT NULL REFERENCES users(id),
  old_data     JSONB,
  new_data     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guarantees_expiry ON bank_guarantees(current_expiry_date)
  WHERE deleted_at IS NULL AND lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS idx_guarantees_bank ON bank_guarantees(issuing_bank) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guarantees_bank_id ON bank_guarantees(bank_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guarantees_beneficiary ON bank_guarantees(beneficiary) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guarantee_extensions ON guarantee_extensions(guarantee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guarantee_documents ON guarantee_documents(guarantee_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_guarantee_audit ON guarantee_audit_log(guarantee_id, created_at DESC);

-- Staging area for incomplete or contradictory legacy guarantee records.
-- These rows are intentionally excluded from exposure, limits and expiry alerts
-- until an administrator validates and promotes them to bank_guarantees.
CREATE TABLE IF NOT EXISTS guarantee_unconfirmed_imports (
  id                   SERIAL PRIMARY KEY,
  source_sheet         VARCHAR(120) NOT NULL,
  source_row           INTEGER NOT NULL,
  guarantee_no         VARCHAR(120),
  company              VARCHAR(10),
  issuing_bank         VARCHAR(150),
  bank_id              INTEGER REFERENCES guarantee_banks(id),
  beneficiary          VARCHAR(250),
  guarantee_type       VARCHAR(40),
  issue_date           DATE,
  original_expiry_date DATE,
  current_expiry_date  DATE,
  amount               NUMERIC(18,2),
  cash_margin_percent  NUMERIC(7,3),
  reference_no         VARCHAR(300),
  description          TEXT,
  source_status        VARCHAR(80),
  lifecycle_status     VARCHAR(20),
  returned_date        DATE,
  remarks              TEXT,
  review_issues        TEXT NOT NULL,
  raw_data             JSONB NOT NULL,
  review_state         VARCHAR(20) NOT NULL DEFAULT 'unconfirmed',
  admin_note           TEXT,
  reviewed_by          INTEGER REFERENCES users(id),
  reviewed_at          TIMESTAMPTZ,
  confirmed_guarantee_id INTEGER REFERENCES bank_guarantees(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_sheet, source_row)
);
CREATE INDEX IF NOT EXISTS idx_guarantee_unconfirmed_state
  ON guarantee_unconfirmed_imports(review_state, source_sheet, source_row);

-- Released and Returned are the same operational outcome in this portal.
UPDATE bank_guarantees SET lifecycle_status='returned', updated_at=NOW()
WHERE lifecycle_status='released';

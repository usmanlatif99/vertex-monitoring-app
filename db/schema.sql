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
ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS comment_id  INTEGER REFERENCES task_comments(id) ON DELETE CASCADE;
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

CREATE TABLE IF NOT EXISTS tp_reminders (
  id              SERIAL PRIMARY KEY,
  rel_type        VARCHAR(50),
  rel_id          INT,
  staff_id        INT REFERENCES tp_staff(id),
  created_by      INT REFERENCES tp_staff(id),
  description     TEXT NOT NULL,
  reminder_date   TIMESTAMP NOT NULL,
  notify_by_email BOOLEAN DEFAULT FALSE,
  is_closed       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- True Path CRM — PostgreSQL Schema
-- Run once against your Netlify Postgres / Neon database

CREATE TABLE IF NOT EXISTS tp_staff (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  firstname     VARCHAR(100),
  lastname      VARCHAR(100),
  is_admin      BOOLEAN DEFAULT FALSE,
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_companies (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  phone      VARCHAR(50),
  address    VARCHAR(500),
  city       VARCHAR(100),
  state      VARCHAR(50),
  zip_code   VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_brokers (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  status     VARCHAR(50) DEFAULT 'Active',
  address    VARCHAR(500),
  email      VARCHAR(255),
  phone      VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_clients (
  id                  SERIAL PRIMARY KEY,
  company_id          INT REFERENCES tp_companies(id),
  broker_id           INT REFERENCES tp_brokers(id),
  firstname           VARCHAR(100),
  lastname            VARCHAR(100),
  email               VARCHAR(255),
  phone               VARCHAR(50),
  active              BOOLEAN DEFAULT TRUE,
  account_coordinator INT REFERENCES tp_staff(id),
  groups              VARCHAR(500),
  notes               TEXT,
  created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_leads (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255),
  company      VARCHAR(255),
  email        VARCHAR(255),
  phone        VARCHAR(50),
  value        NUMERIC(10,2),
  assigned_id  INT REFERENCES tp_staff(id),
  status       VARCHAR(100) DEFAULT 'New',
  source       VARCHAR(100),
  last_contact TIMESTAMP,
  tags         TEXT,
  notes        TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_tasks (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(500) NOT NULL,
  status       VARCHAR(50) DEFAULT 'Not Started',
  priority     VARCHAR(50) DEFAULT 'Medium',
  start_date   DATE,
  due_date     DATE,
  assigned_id  INT REFERENCES tp_staff(id),
  tags         TEXT,
  color        VARCHAR(20),
  related_type VARCHAR(50),
  related_id   INT,
  description  TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_batch (
  id                  SERIAL PRIMARY KEY,
  customer_id         VARCHAR(100),
  transaction_id      VARCHAR(100),
  customer_name       VARCHAR(255),
  drug_name           VARCHAR(255),
  vendor              VARCHAR(255),
  strength            VARCHAR(100),
  unit_quantity       NUMERIC(10,2),
  vendor_quantity     NUMERIC(10,2),
  unit_price          NUMERIC(10,4),
  unit_cost           NUMERIC(10,4),
  transaction_price   NUMERIC(10,2),
  transaction_cost    NUMERIC(10,2),
  shipping_method     VARCHAR(100),
  status              VARCHAR(100) DEFAULT 'Pending',
  transaction_date    DATE,
  document_patient_id VARCHAR(100),
  vendor_day_supply   INT,
  order_id            VARCHAR(100),
  error_message       TEXT,
  created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tp_temp_batch (
  id              SERIAL PRIMARY KEY,
  customer_name   VARCHAR(255),
  customer_id     VARCHAR(100),
  drug            VARCHAR(255),
  vendor          VARCHAR(255),
  day_supply      INT,
  price           NUMERIC(10,4),
  cost            NUMERIC(10,4),
  unit_type       VARCHAR(50),
  unit_quantity   NUMERIC(10,2),
  vendor_quantity NUMERIC(10,2),
  unit_price      NUMERIC(10,4),
  unit_cost       NUMERIC(10,4),
  shipping_method VARCHAR(100),
  date_prescribed DATE,
  num_refills     INT,
  is_refill       BOOLEAN DEFAULT FALSE,
  override        BOOLEAN DEFAULT FALSE,
  status          VARCHAR(50) DEFAULT 'Pending',
  error_message   TEXT,
  import_batch_id VARCHAR(100),
  created_at      TIMESTAMP DEFAULT NOW()
);

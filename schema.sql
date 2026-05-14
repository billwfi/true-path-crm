-- True Path CRM Schema
-- Run this against your SQL Server database before first use

-- Staff (system users)
CREATE TABLE tp_staff (
  id          INT IDENTITY PRIMARY KEY,
  email       NVARCHAR(255) NOT NULL UNIQUE,
  password_hash NVARCHAR(255) NOT NULL,
  firstname   NVARCHAR(100),
  lastname    NVARCHAR(100),
  is_admin    BIT DEFAULT 0,
  active      BIT DEFAULT 1,
  created_at  DATETIME2 DEFAULT GETDATE()
);

-- Companies (employer groups / pharmacy groups)
CREATE TABLE tp_companies (
  id          INT IDENTITY PRIMARY KEY,
  name        NVARCHAR(255) NOT NULL,
  phone       NVARCHAR(50),
  address     NVARCHAR(500),
  city        NVARCHAR(100),
  state       NVARCHAR(50),
  zip_code    NVARCHAR(20),
  created_at  DATETIME2 DEFAULT GETDATE()
);

-- Brokers (benefit brokers / consultants)
CREATE TABLE tp_brokers (
  id          INT IDENTITY PRIMARY KEY,
  name        NVARCHAR(255) NOT NULL,
  status      NVARCHAR(50) DEFAULT 'Active',
  address     NVARCHAR(500),
  email       NVARCHAR(255),
  phone       NVARCHAR(50),
  created_at  DATETIME2 DEFAULT GETDATE()
);

-- Clients (members / patients)
CREATE TABLE tp_clients (
  id                   INT IDENTITY PRIMARY KEY,
  company_id           INT REFERENCES tp_companies(id),
  broker_id            INT REFERENCES tp_brokers(id),
  firstname            NVARCHAR(100),
  lastname             NVARCHAR(100),
  email                NVARCHAR(255),
  phone                NVARCHAR(50),
  active               BIT DEFAULT 1,
  account_coordinator  INT REFERENCES tp_staff(id),
  groups               NVARCHAR(500),
  notes                NVARCHAR(MAX),
  created_at           DATETIME2 DEFAULT GETDATE()
);

-- Leads
CREATE TABLE tp_leads (
  id           INT IDENTITY PRIMARY KEY,
  name         NVARCHAR(255),
  company      NVARCHAR(255),
  email        NVARCHAR(255),
  phone        NVARCHAR(50),
  value        DECIMAL(10,2),
  assigned_id  INT REFERENCES tp_staff(id),
  status       NVARCHAR(100) DEFAULT 'New',
  source       NVARCHAR(100),
  last_contact DATETIME2,
  tags         NVARCHAR(MAX),
  notes        NVARCHAR(MAX),
  created_at   DATETIME2 DEFAULT GETDATE()
);

-- Tasks
CREATE TABLE tp_tasks (
  id           INT IDENTITY PRIMARY KEY,
  name         NVARCHAR(500) NOT NULL,
  status       NVARCHAR(50) DEFAULT 'Not Started',
  priority     NVARCHAR(50) DEFAULT 'Medium',
  start_date   DATE,
  due_date     DATE,
  assigned_id  INT REFERENCES tp_staff(id),
  tags         NVARCHAR(MAX),
  color        NVARCHAR(20),
  related_type NVARCHAR(50),
  related_id   INT,
  description  NVARCHAR(MAX),
  created_at   DATETIME2 DEFAULT GETDATE()
);

-- Batch Orders (fulfilled drug orders)
CREATE TABLE tp_batch (
  id                  INT IDENTITY PRIMARY KEY,
  customer_id         NVARCHAR(100),
  transaction_id      NVARCHAR(100),
  customer_name       NVARCHAR(255),
  drug_name           NVARCHAR(255),
  vendor              NVARCHAR(255),
  strength            NVARCHAR(100),
  unit_quantity       DECIMAL(10,2),
  vendor_quantity     DECIMAL(10,2),
  unit_price          DECIMAL(10,4),
  unit_cost           DECIMAL(10,4),
  transaction_price   DECIMAL(10,2),
  transaction_cost    DECIMAL(10,2),
  shipping_method     NVARCHAR(100),
  status              NVARCHAR(100) DEFAULT 'Pending',
  transaction_date    DATE,
  document_patient_id NVARCHAR(100),
  vendor_day_supply   INT,
  order_id            NVARCHAR(100),
  error_message       NVARCHAR(MAX),
  created_at          DATETIME2 DEFAULT GETDATE()
);

-- Temp Batch (staging / import preview)
CREATE TABLE tp_temp_batch (
  id               INT IDENTITY PRIMARY KEY,
  customer_name    NVARCHAR(255),
  customer_id      NVARCHAR(100),
  drug             NVARCHAR(255),
  vendor           NVARCHAR(255),
  day_supply       INT,
  price            DECIMAL(10,4),
  cost             DECIMAL(10,4),
  unit_type        NVARCHAR(50),
  unit_quantity    DECIMAL(10,2),
  vendor_quantity  DECIMAL(10,2),
  unit_price       DECIMAL(10,4),
  unit_cost        DECIMAL(10,4),
  shipping_method  NVARCHAR(100),
  date_prescribed  DATE,
  num_refills      INT,
  is_refill        BIT DEFAULT 0,
  override         BIT DEFAULT 0,
  status           NVARCHAR(50) DEFAULT 'Pending',
  error_message    NVARCHAR(MAX),
  import_batch_id  NVARCHAR(100),
  created_at       DATETIME2 DEFAULT GETDATE()
);

-- Reminders
CREATE TABLE tp_reminders (
  id           INT IDENTITY PRIMARY KEY,
  related_type NVARCHAR(50),
  related_id   INT,
  description  NVARCHAR(MAX),
  remind_date  DATETIME2,
  staff_id     INT REFERENCES tp_staff(id),
  is_notified  BIT DEFAULT 0,
  created_by   INT REFERENCES tp_staff(id),
  created_at   DATETIME2 DEFAULT GETDATE()
);

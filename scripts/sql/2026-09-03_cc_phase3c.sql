-- Client Concierge — Phase 3, increment 3: Cypress coordination (CS3 + RXF4 + CS4 stats)
--   tp_cypress_requests — Transfer In / Transfer Out / Verbal Request structured records
--   tp_getrx_scripts.lang — EN/ES flag + seeded Cypress scripts (CS3 cypress-scripts)

/* ── tp_cypress_requests ─────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_cypress_requests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_cypress_requests (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    member_key      NVARCHAR(200) NOT NULL,
    intake_type     NVARCHAR(40)  NOT NULL,
    order_id        INT           NULL,
    request_type    NVARCHAR(30)  NOT NULL,   -- Transfer In | Transfer Out | Verbal Request
    member_name     NVARCHAR(200) NULL,
    dob             NVARCHAR(20)  NULL,
    phone           NVARCHAR(40)  NULL,
    address         NVARCHAR(300) NULL,
    medication      NVARCHAR(200) NULL,
    strength        NVARCHAR(100) NULL,
    pharmacy_name   NVARCHAR(200) NULL,       -- Transfer In/Out
    pharmacy_address NVARCHAR(300) NULL,
    pharmacy_phone  NVARCHAR(40)  NULL,
    pharmacy_fax    NVARCHAR(40)  NULL,
    supply_on_hand  NVARCHAR(100) NULL,       -- Transfer Out
    never_filled    BIT           NOT NULL DEFAULT 0,
    prescriber_name NVARCHAR(200) NULL,       -- Verbal Request
    prescriber_phone NVARCHAR(40) NULL,
    rx_file_link    NVARCHAR(1000) NULL,      -- attached Rx (Transfer Out)
    status          NVARCHAR(30)  NOT NULL DEFAULT 'Submitted',  -- Submitted | Sent to Cypress | Completed
    notes           NVARCHAR(MAX) NULL,
    created_by      INT           NULL,
    created_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2     NULL
  );
  CREATE INDEX IX_cypreq_member  ON dbo.tp_cypress_requests (member_key, intake_type);
  CREATE INDEX IX_cypreq_created ON dbo.tp_cypress_requests (created_at);
END
GO

/* ── Cypress scripts (EN/ES) — CS3 cypress-scripts ───────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.tp_getrx_scripts') AND name = 'lang')
  ALTER TABLE dbo.tp_getrx_scripts ADD lang NVARCHAR(10) NOT NULL CONSTRAINT DF_getrx_lang DEFAULT 'EN';
GO

MERGE dbo.tp_getrx_scripts AS t
USING (VALUES
  (N'cypress-refill-en', N'Cypress 90-Day Refill Request (EN)', N'cypress', 'EN', 40,
     N'Requesting a 90-day mail-order refill from Cypress Pharmacy for the member''s current medication. Please process and ship to the address on file.'),
  (N'cypress-refill-es', N'Cypress 90-Day Refill Request (ES)', N'cypress', 'ES', 41,
     N'Solicitud de resurtido por correo de 90 días de Cypress Pharmacy para el medicamento actual del miembro. Por favor, procese y envíe a la dirección registrada.'),
  (N'cypress-transfer-en', N'Cypress Pharmacy Transfer Request (EN)', N'cypress', 'EN', 42,
     N'Requesting a prescription transfer with Cypress Pharmacy. Member and pharmacy details are attached. Please confirm receipt and expected turnaround.'),
  (N'cypress-transfer-es', N'Cypress Pharmacy Transfer Request (ES)', N'cypress', 'ES', 43,
     N'Solicitud de transferencia de receta con Cypress Pharmacy. Se adjuntan los datos del miembro y de la farmacia. Por favor, confirme la recepción y el tiempo estimado.')
) AS s(script_key, title, trigger_point, lang, sort_order, script_text)
ON t.script_key = s.script_key
WHEN NOT MATCHED THEN
  INSERT (script_key, title, trigger_point, lang, sort_order, script_text)
  VALUES (s.script_key, s.title, s.trigger_point, s.lang, s.sort_order, s.script_text);
GO

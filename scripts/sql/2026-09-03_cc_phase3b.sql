-- Client Concierge — Phase 3, increment 2: Rx file processing (metadata + link)
--   tp_rx_records — structured record of each Rx received (naming taxonomy, label,
--   day supply, status, name/DOB confirmation, dosage-change flag, file link).

IF OBJECT_ID('dbo.tp_rx_records', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_rx_records (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    order_id          INT           NULL,       -- tp_orders.id (null if logged before the order)
    member_key        NVARCHAR(200) NOT NULL,
    intake_type       NVARCHAR(40)  NOT NULL,
    member_name       NVARCHAR(200) NULL,       -- as it appears on the Rx (must match profile)
    dob               NVARCHAR(20)  NULL,
    medication        NVARCHAR(200) NULL,
    strength          NVARCHAR(100) NULL,
    written_date      DATE          NULL,       -- WR date
    status            NVARCHAR(40)  NOT NULL DEFAULT 'Valid',
      -- Valid | INVALID | CANNOT SOURCE | DUPLICATE RX | DENIED RX | NEED 90 DAY | CANCELLED RX | NEEDS CLARIFICATION
    invalid_reason    NVARCHAR(200) NULL,        -- for INVALID
    original_wr_date  DATE          NULL,        -- for CANCELLED RX (original WR if linked)
    day_supply        INT           NULL,        -- Valid / NEED 90 DAY only
    file_name         NVARCHAR(400) NULL,        -- generated per naming taxonomy
    label             NVARCHAR(200) NULL,        -- structured Files-tab label
    file_link         NVARCHAR(1000) NULL,       -- reference/link to the stored PDF (SharePoint etc.)
    name_dob_confirmed BIT          NOT NULL DEFAULT 0,
    dosage_changed    BIT           NULL,        -- vs the member's previous Rx
    created_by        INT           NULL,
    created_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2     NULL
  );
  CREATE INDEX IX_rxrec_member ON dbo.tp_rx_records (member_key, intake_type);
  CREATE INDEX IX_rxrec_order  ON dbo.tp_rx_records (order_id);
  CREATE INDEX IX_rxrec_created ON dbo.tp_rx_records (created_at);
END
GO

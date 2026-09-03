-- Tag every contact-tracking record with the workflow area it belongs to, so the
-- intake tabs (Enrollment Outreach / Rx Order & Get Rx / Fulfillment & Tracking)
-- can each show their own contact history.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.GLP1_ContactLog') AND name='work_area')
  ALTER TABLE dbo.GLP1_ContactLog ADD work_area NVARCHAR(40) NULL;
GO

-- Backfill existing rows from what the record tells us about itself.
UPDATE dbo.GLP1_ContactLog
   SET work_area = CASE
     WHEN notes LIKE 'Tracking text%' OR notes LIKE 'Delivery-confirmation%' THEN N'Fulfillment & Tracking'
     WHEN notes LIKE 'Rx received%'   OR notes LIKE 'Get Rx%'                THEN N'Rx Order & Get Rx'
     ELSE N'Enrollment Outreach'   -- outreach attempts and general contact
   END
 WHERE work_area IS NULL;
GO

CREATE INDEX IX_cl_area ON dbo.GLP1_ContactLog (member_key, category, work_area);
GO

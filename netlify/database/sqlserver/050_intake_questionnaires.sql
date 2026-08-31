-- Multiple intake questionnaires per intake track (was a single JSON blob on
-- tp_member_intakes.questionnaire). A GLP-1 intake can hold several questionnaires
-- (one per visit / re-eval). intake_date / followup_date / medication_selected are
-- surfaced as columns for the list; the full answer set stays as JSON in `answers`.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tp_intake_questionnaires')
BEGIN
  CREATE TABLE dbo.tp_intake_questionnaires (
    id                  INT IDENTITY(1,1) CONSTRAINT PK_tp_intake_q PRIMARY KEY,
    member_key          VARCHAR(50)  NOT NULL,
    intake_type         VARCHAR(20)  NOT NULL,
    intake_date         DATE         NULL,
    followup_date       DATE         NULL,
    medication_selected VARCHAR(100) NULL,
    answers             NVARCHAR(MAX) NULL,
    disqualified        BIT NOT NULL CONSTRAINT DF_tp_intake_q_dq   DEFAULT 0,
    completed           BIT NOT NULL CONSTRAINT DF_tp_intake_q_comp DEFAULT 0,
    created_by          INT NULL,
    created_at          DATETIME NOT NULL CONSTRAINT DF_tp_intake_q_ca DEFAULT GETDATE(),
    updated_by          INT NULL,
    updated_at          DATETIME NULL
  );
  CREATE INDEX IX_intake_q_member ON dbo.tp_intake_questionnaires(member_key, intake_type);
END;

-- Backfill any existing single questionnaire from tp_member_intakes.
INSERT INTO dbo.tp_intake_questionnaires
   (member_key, intake_type, intake_date, followup_date, medication_selected, answers, disqualified, completed, created_at)
SELECT mi.member_key, mi.intake_type,
   TRY_CONVERT(date, JSON_VALUE(mi.questionnaire, '$.intake_date')),
   TRY_CONVERT(date, JSON_VALUE(mi.questionnaire, '$.followup_date')),
   LEFT(JSON_VALUE(mi.questionnaire, '$.medication_selected'), 100),
   mi.questionnaire, ISNULL(mi.disqualified, 0), 0, GETDATE()
FROM dbo.tp_member_intakes mi
WHERE mi.questionnaire IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.tp_intake_questionnaires q
                  WHERE q.member_key = mi.member_key AND q.intake_type = mi.intake_type);

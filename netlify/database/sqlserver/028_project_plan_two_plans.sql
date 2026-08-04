-- Split the Project Plan into two distinct plans:
--   'CRM Migration'   — migrating the existing CRM module-by-module (seeded below)
--   'New Development'  — all pre-existing categories (net-new build)
-- The Feedback (FB) category stays plan = NULL; it is surfaced separately under
-- Project Management -> Bugs/Changes and is filtered out of the Project Plan view.

IF COL_LENGTH('dbo.Project_Categories', 'plan') IS NULL
  ALTER TABLE dbo.Project_Categories ADD [plan] NVARCHAR(40) NULL;
GO

-- Everything that already exists (except Feedback) is New Development work.
UPDATE dbo.Project_Categories
   SET [plan] = 'New Development'
 WHERE [plan] IS NULL AND code <> 'FB';
GO

-- Seed the CRM Migration plan: one main category per module of the existing CRM
-- (mirrors the legacy left-nav). Idempotent — safe to re-run.
;WITH v(code, title, goal, sort_order) AS (
  SELECT * FROM (VALUES
    ('DB', 'Dashboard',         'Migrate the legacy home dashboard — KPIs, widgets and landing views.', 100),
    ('VP', 'Vendor Products',   'Migrate the vendor product catalog and pricing.',                      101),
    ('BR', 'Brokers',           'Migrate broker records and relationships.',                            102),
    ('CO', 'Companies',         'Migrate company/account records.',                                     103),
    ('BT', 'Batch',             'Migrate batch order processing.',                                      104),
    ('TB', 'Temporary Batch',   'Migrate the temporary batch intake/staging.',                          105),
    ('CU', 'Customers',         'Migrate customer/member records.',                                      106),
    ('KB', 'Knowledge Base',    'Migrate knowledge base articles and content.',                         107),
    ('LD', 'Leads',             'Migrate leads and the lead pipeline.',                                  108),
    ('PR', 'Proposals',         'Migrate proposals and quoting.',                                        109),
    ('CN', 'Contracts',         'Migrate contracts and contract management.',                            110),
    ('PJ', 'Projects',          'Migrate projects and project tracking.',                               111),
    ('IV', 'Invoices',          'Migrate invoicing and statements.',                                    112),
    ('TK', 'Tasks',             'Migrate tasks and assignments.',                                       113),
    ('IM', 'Imports',           'Migrate eligibility/claims import processes.',                          114),
    ('SP', 'Support',           'Migrate support tickets/case management.',                              115),
    ('ER', 'Estimate Request',  'Migrate the estimate request intake.',                                 116),
    ('UT', 'Utilities',         'Migrate admin utilities and tools.',                                   117),
    ('RP', 'Reports',           'Migrate reporting and analytics.',                                     118),
    ('SL', 'Sales',             'Migrate sales tracking and pipeline.',                                 119),
    ('ST', 'Setup',             'Migrate system setup and configuration.',                              120)
  ) x(code, title, goal, sort_order)
)
INSERT INTO dbo.Project_Categories (code, title, goal, sort_order, [plan])
SELECT v.code, v.title, v.goal, v.sort_order, 'CRM Migration'
  FROM v
 WHERE NOT EXISTS (
   SELECT 1 FROM dbo.Project_Categories c
    WHERE c.[plan] = 'CRM Migration' AND c.title = v.title);
GO

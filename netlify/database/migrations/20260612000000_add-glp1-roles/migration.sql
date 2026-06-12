-- Add staff role to support GLP1 assignment workflow.
-- Roles: 'Admin', 'Call Center Manager', 'Client Concierge', 'Staff'
ALTER TABLE tp_staff ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'Staff';

-- Existing admins keep elevated access; mark them as Admin role.
UPDATE tp_staff SET role = 'Admin' WHERE is_admin = TRUE AND role = 'Staff';

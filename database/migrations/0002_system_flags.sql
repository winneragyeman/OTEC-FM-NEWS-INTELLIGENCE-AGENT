-- Migration: 0002_system_flags.sql
-- Description: System flags table for kill switch and operational controls

CREATE TABLE IF NOT EXISTS system_flags (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pipeline_enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT,
  reason TEXT
);

INSERT INTO system_flags (id, pipeline_enabled)
VALUES (1, true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE system_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON system_flags
  FOR ALL TO service_role USING (true) WITH CHECK (true);

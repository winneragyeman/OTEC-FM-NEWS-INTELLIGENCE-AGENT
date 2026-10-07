-- Migration: 0003_baseline_snapshots.sql
-- Description: Pipeline run locks and baseline ranking snapshots

CREATE TABLE IF NOT EXISTS pipeline_run_locks (
  run_type TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL,
  locked_by TEXT,
  locked_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE pipeline_run_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON pipeline_run_locks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS baseline_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id UUID REFERENCES clusters(id) ON DELETE CASCADE,
  score NUMERIC(5,4) NOT NULL,
  components JSONB NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_cluster
  ON baseline_snapshots(cluster_id, computed_at DESC);

ALTER TABLE baseline_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON baseline_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

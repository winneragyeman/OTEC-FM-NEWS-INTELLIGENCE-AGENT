-- Migration: 0004_scoring_pipeline.sql
-- Description: LLM dual-axis scoring tracking, pipeline config, and model quota tracking

-- Track which model scored each cluster
ALTER TABLE scores 
  ADD COLUMN IF NOT EXISTS scoring_model TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS route TEXT,
  ADD COLUMN IF NOT EXISTS keyword_flags TEXT[];

-- Pipeline configuration
CREATE TABLE IF NOT EXISTS pipeline_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO pipeline_config (key, value) VALUES
  ('scoring_funnel_size', '30'),
  ('scoring_batch_size', '5'),
  ('scoring_daily_limit', '80')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE pipeline_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON pipeline_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Per-model quota tracking table
CREATE TABLE IF NOT EXISTS model_quota_tracking (
  model_id TEXT PRIMARY KEY,
  calls_today INTEGER DEFAULT 0,
  last_reset DATE DEFAULT CURRENT_DATE,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE model_quota_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON model_quota_tracking
  FOR ALL TO service_role USING (true) WITH CHECK (true);

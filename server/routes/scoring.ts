import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { runScoringPipeline } from '../services/scoring-batch.service.ts';
import { supabase } from '../db/client.ts';

const router = Router();

function verifyPipelineSecret(req: Request, res: Response, next: NextFunction): void {
  const secretHeader = req.header('X-Pipeline-Secret');
  const expectedSecret = process.env.PIPELINE_TICK_SECRET;

  if (!secretHeader || !expectedSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized: Missing pipeline secret' });
    return;
  }

  const headerBuf = Buffer.from(secretHeader);
  const expectedBuf = Buffer.from(expectedSecret);

  if (headerBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(headerBuf, expectedBuf)) {
    res.status(401).json({ success: false, error: 'Unauthorized: Invalid pipeline secret' });
    return;
  }

  next();
}

/**
 * POST /api/scoring/run
 * Protected by X-Pipeline-Secret header.
 * Runs LLM scoring across top pending clusters with optional funnelSize & batchSize.
 */
router.post('/run', verifyPipelineSecret, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { funnelSize, batchSize } = req.body || {};
    const parsedFunnel = typeof funnelSize === 'number' ? funnelSize : undefined;
    const parsedBatch = typeof batchSize === 'number' ? batchSize : undefined;

    const summary = await runScoringPipeline(parsedFunnel, parsedBatch);
    res.json({ success: true, summary });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/scoring/cluster/:id
 * Returns the latest score record for the specified cluster.
 */
router.get('/cluster/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('cluster_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      res.status(404).json({ success: false, error: `No score record found for cluster ${id}` });
      return;
    }

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;

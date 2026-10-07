import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { rankClustersByBaseline } from '../services/baseline.service.ts';
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
 * POST /api/baseline/rank
 * Protected by X-Pipeline-Secret header.
 * Runs non-LLM baseline ranking across active clusters.
 */
router.post('/rank', verifyPipelineSecret, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ranked = await rankClustersByBaseline(20);
    res.json({ success: true, ranked });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/baseline/cluster/:id
 * Returns the most recent baseline snapshot for the specified cluster.
 */
router.get('/cluster/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('baseline_snapshots')
      .select('*')
      .eq('cluster_id', id)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      res.status(404).json({ success: false, error: `No baseline snapshot found for cluster ${id}` });
      return;
    }

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;

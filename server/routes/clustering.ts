import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { clusterArticles } from '../services/clustering.service.ts';

const router = Router();

function timingSafeMatch(headerVal: string, expectedVal: string): boolean {
  if (typeof headerVal !== 'string' || typeof expectedVal !== 'string') {
    return false;
  }
  const bufA = Buffer.from(headerVal);
  const bufB = Buffer.from(expectedVal);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * POST /api/clustering/run
 * Protected by PIPELINE_TICK_SECRET header. Calls clusterArticles() and returns the summary.
 */
router.post('/run', async (req: Request, res: Response) => {
  const secretHeader =
    (req.headers['x-pipeline-tick-secret'] as string) ||
    (req.headers['pipeline-tick-secret'] as string) ||
    '';
  const expectedSecret = process.env.PIPELINE_TICK_SECRET || '';

  if (!expectedSecret || !timingSafeMatch(secretHeader, expectedSecret)) {
    return res.status(401).json({
      error: 'Unauthorized: missing or invalid PIPELINE_TICK_SECRET header',
    });
  }

  try {
    const summary = await clusterArticles();
    return res.json({
      success: true,
      summary,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Clustering Route] Error running clustering pipeline:', message);
    return res.status(500).json({
      error: message,
    });
  }
});

export default router;

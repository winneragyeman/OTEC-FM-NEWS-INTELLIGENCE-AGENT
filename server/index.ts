import { Router } from 'express';
import sourcesRouter from './routes/sources.ts';
import clusteringRouter from './routes/clustering.ts';
import baselineRouter from './routes/baseline.ts';
import scoringRouter from './routes/scoring.ts';

const apiRouter = Router();

apiRouter.use('/sources', sourcesRouter);
apiRouter.use('/clustering', clusteringRouter);
apiRouter.use('/baseline', baselineRouter);
apiRouter.use('/scoring', scoringRouter);

apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    brand: 'OTEC FM',
    frequency: '102.9 MHz',
    city: 'Kumasi',
    region: 'Ashanti',
    country: 'Ghana',
    initialized: true,
    timestamp: new Date().toISOString()
  });
});

export default apiRouter;

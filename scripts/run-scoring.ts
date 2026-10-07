import { config } from 'dotenv';
config();

import { getPipelineConfigNumber } from '../server/lib/quota-tracker.ts';
import { runScoringPipeline } from '../server/services/scoring-batch.service.ts';

async function main() {
  try {
    const funnelSize = await getPipelineConfigNumber('scoring_funnel_size', 30);
    const batchSize = await getPipelineConfigNumber('scoring_batch_size', 5);

    console.log(`[Scoring] Starting LLM scoring pipeline (funnelSize: ${funnelSize}, batchSize: ${batchSize})...`);
    const summary = await runScoringPipeline(funnelSize, batchSize);

    console.log('='.repeat(50));
    console.log('OTEC FM News Intelligence — LLM Scoring Summary');
    console.log('='.repeat(50));
    console.log(`Primary Model:       ${summary.primary_model}`);
    console.log(`Fallback Used:       ${summary.fallback_used ? 'YES' : 'NO'}`);
    console.log(`Clusters Processed:  ${summary.clusters_processed}`);
    console.log(`Clusters Scored:     ${summary.clusters_scored}`);
    console.log(`Clusters Held:       ${summary.clusters_held}`);
    console.log(`Clusters Rejected:   ${summary.clusters_rejected}`);
    console.log(`API Calls Made:      ${summary.api_calls}`);
    console.log(`Estimated Cost:      ${summary.cost_cents.toFixed(2)} cents`);
    console.log('='.repeat(50));

    process.exit(0);
  } catch (err) {
    console.error('[Scoring] Pipeline execution failed:', err);
    process.exit(1);
  }
}

main();

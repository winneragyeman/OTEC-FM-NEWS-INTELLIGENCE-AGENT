import { clusterArticles } from '../server/services/clustering.service.ts';

async function main() {
  console.log('[Clustering] Starting clustering run...');
  const startTime = Date.now();

  try {
    const summary = await clusterArticles();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('[Clustering] Run completed successfully:');
    console.log(`- Articles processed:  ${summary.articles_processed}`);
    console.log(`- Clusters created:    ${summary.clusters_created}`);
    console.log(`- Merged pairs:        ${summary.merged_pairs}`);
    console.log(`- Classifier LLM calls:${summary.classifier_calls}`);
    console.log(`- Duration:            ${duration}s`);
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Clustering] Fatal error in clustering script: ${message}`);
    process.exit(1);
  }
}

main();

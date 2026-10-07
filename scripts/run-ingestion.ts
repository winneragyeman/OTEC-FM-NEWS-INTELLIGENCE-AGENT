import { config } from 'dotenv';
config();

import { ingestAllSources } from '../server/services/ingestion.service.ts';

async function main() {
  console.log('[Ingestion] Starting ingestion run across configured sources...');
  const startTime = Date.now();

  try {
    const summary = await ingestAllSources();
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('[Ingestion] Run completed successfully:');
    console.log(`- Sources attempted: ${summary.sources_attempted}`);
    console.log(`- Articles fetched:   ${summary.articles_fetched}`);
    console.log(`- New articles added: ${summary.new_articles}`);
    console.log(`- Sources with errors:${summary.errors}`);
    console.log(`- Duration:           ${duration}s`);
    process.exit(0);
  } catch (err: unknown) {
    console.error('[Ingestion] Fatal error during ingestion:');
    if (err instanceof Error) {
      console.error(err.stack || err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

main();

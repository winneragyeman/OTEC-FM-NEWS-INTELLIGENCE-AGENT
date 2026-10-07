import { config } from 'dotenv';
config();

import { rankClustersByBaseline } from '../server/services/baseline.service.ts';

async function main() {
  try {
    const ranked = await rankClustersByBaseline(20);

    if (ranked.length === 0) {
      console.log('No clusters found for baseline ranking.');
      process.exit(0);
    }

    const pad = (str: string | number, len: number) => String(str).padEnd(len);

    console.log(
      [
        pad('Rank', 5),
        pad('Score', 8),
        pad('Headline', 40),
        pad('Outlets', 8),
        pad('Velocity', 9),
        pad('Age_hours', 10),
        pad('Recency', 8),
        pad('Outlet_norm', 11),
      ].join(' | ')
    );
    console.log('-'.repeat(108));

    ranked.forEach((item, index) => {
      const headline = item.headline.length > 37 ? item.headline.slice(0, 37) + '...' : item.headline;
      console.log(
        [
          pad(index + 1, 5),
          pad(item.score.toFixed(4), 8),
          pad(headline, 40),
          pad(item.components.outlet_count, 8),
          pad(item.components.velocity, 9),
          pad(item.components.age_hours.toFixed(2), 10),
          pad(item.components.recency_norm.toFixed(4), 8),
          pad(item.components.outlet_norm.toFixed(4), 11),
        ].join(' | ')
      );
    });

    process.exit(0);
  } catch (err) {
    console.error('[Baseline] Failed to run baseline ranking:', err);
    process.exit(1);
  }
}

main();

import { config } from 'dotenv';
config();

import pLimit from 'p-limit';
import { supabase } from '../server/db/client.ts';
import { computeBaselineScore } from '../server/services/baseline.service.ts';

function getPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

async function main() {
  try {
    const { data: clusters, error } = await supabase
      .from('clusters')
      .select('id, headline, status')
      .in('status', ['pending', 'scored', 'editorial_ready']);

    if (error) {
      throw new Error(`Failed to fetch clusters: ${error.message}`);
    }

    const clusterList = clusters || [];
    console.log(`[Baseline Stats] Computing scores for ${clusterList.length} clusters...`);

    const limit = pLimit(10);
    const tasks = clusterList.map((c) =>
      limit(async () => {
        const { score } = await computeBaselineScore(c.id);
        return {
          cluster_id: c.id,
          score,
          headline: c.headline || 'Untitled',
        };
      })
    );

    const evaluated = await Promise.all(tasks);

    // Sort descending by score for list output
    evaluated.sort((a, b) => b.score - a.score);

    // Extract sorted ascending scores for quantile calculation
    const scores = evaluated.map((e) => e.score).sort((a, b) => a - b);
    const total = scores.length;

    const minScore = total > 0 ? scores[0] : 0;
    const maxScore = total > 0 ? scores[total - 1] : 0;
    const medianScore = getPercentile(scores, 0.50);
    const p25Score = getPercentile(scores, 0.25);
    const p75Score = getPercentile(scores, 0.75);

    const buckets = {
      '0.0-0.2': 0,
      '0.2-0.4': 0,
      '0.4-0.6': 0,
      '0.6-0.8': 0,
      '0.8-1.0': 0,
    };

    for (const s of scores) {
      if (s < 0.2) {
        buckets['0.0-0.2']++;
      } else if (s < 0.4) {
        buckets['0.2-0.4']++;
      } else if (s < 0.6) {
        buckets['0.4-0.6']++;
      } else if (s < 0.8) {
        buckets['0.6-0.8']++;
      } else {
        buckets['0.8-1.0']++;
      }
    }

    console.log('\n=== Baseline Ranking Distribution ===');
    console.log(`- Total clusters: ${total}`);
    console.log(`- Min score:     ${minScore.toFixed(4)}`);
    console.log(`- Max score:     ${maxScore.toFixed(4)}`);
    console.log(`- Median score:  ${medianScore.toFixed(4)}`);
    console.log(`- p25 score:     ${p25Score.toFixed(4)}`);
    console.log(`- p75 score:     ${p75Score.toFixed(4)}`);

    console.log('\n=== Count by Score Bucket ===');
    console.log(`- 0.0-0.2: ${buckets['0.0-0.2']}`);
    console.log(`- 0.2-0.4: ${buckets['0.2-0.4']}`);
    console.log(`- 0.4-0.6: ${buckets['0.4-0.6']}`);
    console.log(`- 0.6-0.8: ${buckets['0.6-0.8']}`);
    console.log(`- 0.8-1.0: ${buckets['0.8-1.0']}`);

    console.log('\n=== Cluster Rankings (Descending) ===');
    console.log('cluster_id | score | headline');
    console.log('-'.repeat(80));

    for (const item of evaluated) {
      console.log(`${item.cluster_id} | ${item.score.toFixed(4)} | ${item.headline}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('[Baseline Stats] Failed to generate baseline statistics:', err);
    process.exit(1);
  }
}

main();

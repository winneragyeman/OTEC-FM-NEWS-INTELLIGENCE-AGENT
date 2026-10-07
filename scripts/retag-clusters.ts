import pLimit from 'p-limit';
import { supabase } from '../server/db/client.ts';
import { findLocations } from '../server/services/gazetteer.service.ts';

interface ClusterRow {
  id: string;
  combined_text: string | null;
  locations: string[] | null;
}

function areLocationsEqual(a: string[] | null | undefined, b: string[]): boolean {
  const arrA = Array.isArray(a) ? [...a].sort() : [];
  const arrB = [...b].sort();
  if (arrA.length !== arrB.length) return false;
  return arrA.every((val, idx) => val === arrB[idx]);
}

async function retagClusters() {
  console.log('[Retag] Starting cluster location re-tagging...');
  const startTime = Date.now();

  let allClusters: ClusterRow[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('clusters')
      .select('id, combined_text, locations')
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      throw new Error(`Failed to fetch clusters: ${error.message}`);
    }

    if (!data || data.length === 0) break;
    allClusters = allClusters.concat(data as ClusterRow[]);
    if (data.length < pageSize) break;
    page++;
  }

  let totalProcessed = 0;
  let locationsChanged = 0;
  let locationsBecameEmpty = 0;

  const limit = pLimit(5);

  const updateTasks = allClusters.map((cluster) =>
    limit(async () => {
      totalProcessed++;
      const text = cluster.combined_text || '';
      const newLocations = findLocations(text);
      const oldLocations = cluster.locations || [];

      if (!areLocationsEqual(oldLocations, newLocations)) {
        locationsChanged++;
        if (oldLocations.length > 0 && newLocations.length === 0) {
          locationsBecameEmpty++;
        }

        const { error: updateError } = await supabase
          .from('clusters')
          .update({ locations: newLocations })
          .eq('id', cluster.id);

        if (updateError) {
          console.error(`[Retag] Failed to update cluster ${cluster.id}:`, updateError.message);
        }
      }
    })
  );

  await Promise.all(updateTasks);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('[Retag] Re-tagging completed successfully:');
  console.log(`- Total clusters processed:             ${totalProcessed}`);
  console.log(`- Clusters whose locations changed:      ${locationsChanged}`);
  console.log(`- Clusters whose locations became empty: ${locationsBecameEmpty}`);
  console.log(`- Duration:                             ${duration}s`);
}

retagClusters().catch((err) => {
  console.error('[Retag] Fatal error:', err);
  process.exit(1);
});

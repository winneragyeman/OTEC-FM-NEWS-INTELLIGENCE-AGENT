import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../db/client.ts';
import { toggleSource } from '../db/sources.repo.ts';
import { requireEditor } from '../middleware/auth.ts';
import { validateSafeUrl, SsrfError } from '../services/ssrf.service.ts';

const router = Router();

const CreateSourceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['rss', 'html', 'api']).or(z.string()),
  url: z.string().min(1, 'URL is required'),
  region: z.string().optional().default('National'),
});

// GET /api/sources - List all sources with their latest health record
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data: sources, error: sourcesError } = await supabase
      .from('sources')
      .select('*')
      .order('name', { ascending: true });

    if (sourcesError) {
      throw sourcesError;
    }

    const { data: healthRecords, error: healthError } = await supabase
      .from('source_health')
      .select('*')
      .order('checked_at', { ascending: false });

    if (healthError) {
      // Non-fatal, return sources without health records if table doesn't have rows
      return res.json({ success: true, data: sources || [] });
    }

    // Attach latest health record to each source
    const healthMap = new Map<string, any>();
    for (const record of healthRecords || []) {
      if (!healthMap.has(record.source_id)) {
        healthMap.set(record.source_id, record);
      }
    }

    const enriched = (sources || []).map((source) => ({
      ...source,
      latest_health: healthMap.get(source.id) || null,
    }));

    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/sources - Add a new source (Requires editor auth and strict SSRF check)
router.post('/', requireEditor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedBody = CreateSourceSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsedBody.error.format(),
      });
      return;
    }

    const { name, type, url, region } = parsedBody.data;

    // Strict URL and SSRF validation
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        res.status(400).json({
          success: false,
          error: 'Invalid URL protocol. Only http: and https: protocols are permitted.',
        });
        return;
      }

      await validateSafeUrl(url);
    } catch (ssrfErr) {
      const msg = ssrfErr instanceof SsrfError || ssrfErr instanceof Error
        ? ssrfErr.message
        : 'SSRF URL validation failed';
      res.status(400).json({
        success: false,
        error: `SSRF Guard Rejected: ${msg}`,
      });
      return;
    }

    // Insert into sources table
    const { data: createdSource, error: insertError } = await supabase
      .from('sources')
      .insert({
        name,
        source_type: type,
        url,
        feed_url: url,
        region,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insertError) {
      throw insertError;
    }

    res.status(201).json({ success: true, data: createdSource });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/sources/:id/toggle - Toggle source active status
router.patch('/:id/toggle', requireEditor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ success: false, error: 'Source ID is required' });
      return;
    }

    const updated = await toggleSource(id);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

export default router;

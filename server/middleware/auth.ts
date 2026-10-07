import { Request, Response, NextFunction } from 'express';
import { supabase } from '../db/client.ts';
import { getEditorBySupabaseId, EditorRecord } from '../db/editors.repo.ts';

declare global {
  namespace Express {
    interface Request {
      editor?: EditorRecord;
    }
  }
}

export async function requireEditor(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Authorization token required' });
    return;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    res.status(401).json({ success: false, error: 'Empty bearer token' });
    return;
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user) {
      res.status(401).json({ success: false, error: 'Invalid or expired authorization token' });
      return;
    }

    const editor = await getEditorBySupabaseId(authData.user.id);
    if (!editor || !editor.is_active) {
      res.status(403).json({ success: false, error: 'Forbidden: Active editor profile required' });
      return;
    }

    req.editor = editor;
    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Authentication verification failed';
    res.status(401).json({ success: false, error: message });
  }
}

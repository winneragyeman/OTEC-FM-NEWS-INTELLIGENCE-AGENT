import { supabase } from './client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface EditorRecord {
  id: string;
  supabase_user_id?: string | null;
  telegram_id?: string | null;
  name: string;
  role: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export async function getEditorBySupabaseId(id: string): Promise<EditorRecord | null> {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .eq('supabase_user_id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new DatabaseError(`Failed to fetch editor by Supabase ID ${id}: ${error.message}`, error);
  }
  return data as EditorRecord;
}

export async function getEditorByTelegramId(id: string): Promise<EditorRecord | null> {
  const { data, error } = await supabase
    .from('editors')
    .select('*')
    .eq('telegram_id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new DatabaseError(`Failed to fetch editor by Telegram ID ${id}: ${error.message}`, error);
  }
  return data as EditorRecord;
}

export async function createEditor(data: Partial<EditorRecord>): Promise<EditorRecord> {
  const { data: created, error } = await supabase
    .from('editors')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to create editor: ${error.message}`, error);
  }
  return created as EditorRecord;
}

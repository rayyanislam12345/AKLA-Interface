import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set');
}

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

// Where the session is kept. Normally localStorage; when the browser refuses
// it (the Hub framed in the companion's side panel with third-party cookies
// blocked, a private window with storage blocked) even reading
// `localStorage` throws, which would stop the app from starting at all. Then
// the session lives in memory for as long as the page does: the person signs
// in again next time, but the page works.
function authStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } {
  try {
    const s = window.localStorage;
    s.getItem('hub-storage-check');
    return s;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => (memory.has(key) ? memory.get(key)! : null),
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    };
  }
}

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: authStorage(),
    persistSession: true,
    autoRefreshToken: true,
  }
});
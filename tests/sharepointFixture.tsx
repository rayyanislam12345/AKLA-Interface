import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import SharePointSearchPage from '../src/pages/SharePointSearchPage';
import { supabase } from '../src/integrations/supabase/client';
import '../src/index.css';
// The page only needs someone to be signed in; the search itself is answered by the test (browser-smoke.mjs).
Object.assign(supabase.auth, { getSession: async () => ({ data: { session: { access_token: 'fixture' } }, error: null }) });
createRoot(document.getElementById('root')!).render(<BrowserRouter><SharePointSearchPage/></BrowserRouter>);

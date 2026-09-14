import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProjectSearchPage from '../src/pages/ProjectSearchPage';
import { saveDraftToMatter } from '../src/lib/saveDraftToMatter';
import '../src/index.css';
(window as any).saveFixture = () => saveDraftToMatter({ matterId: '00000000-0000-0000-0000-000000000002', documentTypeId: '00000000-0000-0000-0000-000000000004', documentTypeName: 'Agreement', blob: new Blob(['fixture'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) });
createRoot(document.getElementById('root')!).render(<BrowserRouter><QueryClientProvider client={new QueryClient({ defaultOptions:{queries:{retry:false}} })}><ProjectSearchPage/></QueryClientProvider></BrowserRouter>);

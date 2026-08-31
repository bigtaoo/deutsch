import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initStoragePersistence } from './db';

// FR-11.16: 启动时申请持久化配额，不阻塞渲染。
void initStoragePersistence();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

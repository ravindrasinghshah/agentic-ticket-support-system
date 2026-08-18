import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { AdminPage } from './pages/admin-page';
import { SupportPage } from './pages/support-page';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<SupportPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

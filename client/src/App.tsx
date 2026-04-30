import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import CrashDetail from './pages/CrashDetail';
import Settings from './pages/Settings';
import Classification from './pages/Classification';
import JiraIssues from './pages/JiraIssues';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/crash/:id" element={<CrashDetail />} />
        <Route path="/classification" element={<Classification />} />
        <Route path="/jira" element={<JiraIssues />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

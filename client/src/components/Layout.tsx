import { Outlet, NavLink } from 'react-router-dom';
import { LayoutDashboard, Settings, Plane, Tags, Ticket } from 'lucide-react';
import UpdateNotification from './UpdateNotification';
import './Layout.css';

export default function Layout() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <Plane size={28} />
          <span>CrashPilot</span>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <LayoutDashboard size={20} />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/classification" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <Tags size={20} />
            <span>Classification</span>
          </NavLink>
          <NavLink to="/jira" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <Ticket size={20} />
            <span>Jira Issues</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <Settings size={20} />
            <span>Settings</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <span className="version">v{__APP_VERSION__}</span>
        </div>
      </aside>
      <main className="main-content">
        <UpdateNotification />
        <Outlet />
      </main>
    </div>
  );
}

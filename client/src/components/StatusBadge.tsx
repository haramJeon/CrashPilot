import type { CrashStatus } from '../types';
import './StatusBadge.css';

const STATUS_CONFIG: Record<CrashStatus, { label: string; className: string }> = {
  new: { label: 'New', className: 'badge-new' },
  downloading: { label: 'Downloading', className: 'badge-downloading' },
  analyzing: { label: 'Analyzing', className: 'badge-analyzing' },
  fixing: { label: 'Fixing', className: 'badge-fixing' },
  creating_pr: { label: 'Creating PR', className: 'badge-creating-pr' },
  completed: { label: 'Completed', className: 'badge-completed' },
  error: { label: 'Error', className: 'badge-error' },
};

export default function StatusBadge({ status }: { status: CrashStatus }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.new;
  return <span className={`badge ${config.className}`}>{config.label}</span>;
}

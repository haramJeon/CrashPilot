import { useEffect, useRef, useState } from 'react';
import type { PipelineStep } from '../types';
import { CheckCircle, Circle, Loader, XCircle, ChevronDown, ChevronRight, Bot } from 'lucide-react';
import './PipelineView.css';

interface Props {
  steps: PipelineStep[];
  onRunAI?: () => void;
}

const StepIcon = ({ status }: { status: PipelineStep['status'] }) => {
  switch (status) {
    case 'done':
      return <CheckCircle size={20} className="step-icon step-done" />;
    case 'running':
      return <Loader size={20} className="step-icon step-running" />;
    case 'error':
      return <XCircle size={20} className="step-icon step-error" />;
    case 'awaiting':
      return <Bot size={20} className="step-icon step-awaiting" />;
    default:
      return <Circle size={20} className="step-icon step-pending" />;
  }
};

function StepLogs({ step }: { step: PipelineStep }) {
  const isRunning = step.status === 'running';
  const hasLogs = step.logs && step.logs.length > 0;
  const [expanded, setExpanded] = useState(isRunning);
  const logsRef = useRef<HTMLDivElement>(null);

  // Auto-expand when step starts running
  useEffect(() => {
    if (isRunning) setExpanded(true);
  }, [isRunning]);

  // Auto-scroll to bottom when new logs arrive while running
  useEffect(() => {
    if (isRunning && expanded && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [step.logs, isRunning, expanded]);

  if (!hasLogs) return null;

  return (
    <div className="step-logs-wrapper">
      <button className="step-logs-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? 'Hide' : 'Show'} logs ({step.logs!.length})
      </button>
      {expanded && (
        <div className="step-logs" ref={logsRef}>
          {step.logs!.map((line, i) => (
            <div key={i} className="step-log-line">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PipelineView({ steps, onRunAI }: Props) {
  return (
    <div className="pipeline">
      {steps.map((step, idx) => (
        <div key={idx} className={`pipeline-step pipeline-step-${step.status}`}>
          <div className="step-header">
            <StepIcon status={step.status} />
            <span className="step-name">{step.name}</span>
            {step.status === 'awaiting' && onRunAI && (
              <button className="btn-run-ai" onClick={onRunAI}>
                <Bot size={13} />
                Run by AI
              </button>
            )}
          </div>
          {step.message && <div className="step-message">{step.message}</div>}
          <StepLogs step={step} />
          {idx < steps.length - 1 && <div className="step-connector" />}
        </div>
      ))}
    </div>
  );
}

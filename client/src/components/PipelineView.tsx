import type { PipelineStep } from '../types';
import { CheckCircle, Circle, Loader, XCircle } from 'lucide-react';
import './PipelineView.css';

interface Props {
  steps: PipelineStep[];
}

const StepIcon = ({ status }: { status: PipelineStep['status'] }) => {
  switch (status) {
    case 'done':
      return <CheckCircle size={20} className="step-icon step-done" />;
    case 'running':
      return <Loader size={20} className="step-icon step-running" />;
    case 'error':
      return <XCircle size={20} className="step-icon step-error" />;
    default:
      return <Circle size={20} className="step-icon step-pending" />;
  }
};

export default function PipelineView({ steps }: Props) {
  return (
    <div className="pipeline">
      {steps.map((step, idx) => (
        <div key={idx} className={`pipeline-step pipeline-step-${step.status}`}>
          <div className="step-header">
            <StepIcon status={step.status} />
            <span className="step-name">{step.name}</span>
          </div>
          {step.message && <div className="step-message">{step.message}</div>}
          {idx < steps.length - 1 && <div className="step-connector" />}
        </div>
      ))}
    </div>
  );
}

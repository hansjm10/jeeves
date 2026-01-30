import { evaluateGuard } from './guards.js';
import type { Phase, PhaseType, Workflow } from './workflow.js';

export class WorkflowEngine {
  readonly workflow: Workflow;

  constructor(workflow: Workflow) {
    this.workflow = workflow;
  }

  getPhase(phaseName: string): Phase | undefined {
    return this.workflow.phases[phaseName];
  }

  getStartPhase(): Phase {
    const phase = this.getPhase(this.workflow.start);
    if (!phase) throw new Error(`Start phase '${this.workflow.start}' not found in workflow`);
    return phase;
  }

  isTerminal(phaseName: string): boolean {
    const phase = this.getPhase(phaseName);
    return phase?.type === 'terminal';
  }

  getPhaseType(phaseName: string): PhaseType | undefined {
    return this.getPhase(phaseName)?.type;
  }

  getPromptForPhase(phaseName: string): string | undefined {
    return this.getPhase(phaseName)?.prompt;
  }

  evaluateTransitions(currentPhase: string, context: Record<string, unknown>): string | null {
    const phase = this.getPhase(currentPhase);
    if (!phase) return null;

    if (phase.type === 'terminal') return null;

    for (const transition of phase.transitions) {
      if (transition.auto) return transition.to;
      if (transition.when && evaluateGuard(transition.when, context)) return transition.to;
    }

    return null;
  }
}

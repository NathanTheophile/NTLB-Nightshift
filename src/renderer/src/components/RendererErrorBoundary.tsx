import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  errorMessage: string | null;
}

export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  public state: RendererErrorBoundaryState = { errorMessage: null };

  public static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return {
      errorMessage: error instanceof Error ? error.message : 'The renderer stopped unexpectedly.',
    };
  }

  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('NightShift renderer failed.', error, info.componentStack);
  }

  public render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div className="fatal-renderer-error" role="alert">
          <span>NIGHTSHIFT</span>
          <h1>L’interface n’a pas pu démarrer</h1>
          <p>{this.state.errorMessage}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

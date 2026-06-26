import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    const err = e as { stack?: string; message?: string };
    return { err: String(err?.stack || err?.message || e) };
  }
  render() {
    if (this.state.err) {
      return (
        <pre style={{ color: '#ff6b6b', padding: 20, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {this.state.err}
        </pre>
      );
    }
    return this.props.children;
  }
}

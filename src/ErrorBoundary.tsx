import { Component, type ReactNode } from "react";

// Generic error boundary. Without one, an uncaught error thrown during render or inside a
// useEffect (e.g. WebGL context creation failing in FlyView3D) propagates to the React root and
// unmounts the *entire* app, leaving a blank window. Wrapping the heavy/optional viewports keeps a
// single-pane failure contained to that pane.

interface Props {
  children: ReactNode;
  /** Inline fallback shown in place of the failed subtree. Receives a retry callback. */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  /** Label used in the default fallback (e.g. "3D view"). */
  label?: string;
}
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface to the console for debugging; the UI shows the inline fallback.
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error, info);
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 8, width: "100%", height: "100%", padding: 16, boxSizing: "border-box",
        background: "#0a0f1e", color: "#94a3b8", textAlign: "center",
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#f87171" }}>
          {this.props.label ?? "This view"} failed to render
        </div>
        <div style={{ fontSize: 10, color: "#64748b", maxWidth: 280, wordBreak: "break-word" }}>
          {error.message || String(error)}
        </div>
        <button
          onClick={this.retry}
          style={{
            background: "#1e293b", color: "#cbd5e1", border: "1px solid #475569",
            borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer",
          }}
        >Retry</button>
      </div>
    );
  }
}

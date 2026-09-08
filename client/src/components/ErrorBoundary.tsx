import { h, Component, Fragment, type ComponentChildren } from "preact";
import styles from "../styles/components.module.css";

interface ErrorBoundaryProps {
  children: ComponentChildren;
  fallback?: (error: Error) => ComponentChildren;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children, fallback } = this.props;

    if (error) {
      if (fallback) {
        return <Fragment>{fallback(error)}</Fragment>;
      }

      return (
        <div class={styles.errorState} role="alert">
          <p class={styles.errorText}>
            Something went wrong while rendering this content.
          </p>
          <button class={styles.backButton} onClick={this.handleRetry}>
            Try again
          </button>
        </div>
      );
    }

    return <Fragment>{children}</Fragment>;
  }
}

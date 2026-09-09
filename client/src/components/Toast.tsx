import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Toast } from "@shared/types";
import styles from "../styles/components.module.css";

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const DEFAULT_DURATION = 5000;

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [exiting, setExiting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const duration = toast.duration ?? DEFAULT_DURATION;

  const dismiss = () => {
    setExiting(true);
    window.setTimeout(() => {
      setRemoved(true);
      onDismiss(toast.id);
    }, 200);
  };

  useEffect(() => {
    const timer = window.setTimeout(dismiss, duration);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  useEffect(() => {
    setRemoved(false);
    setExiting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  if (removed) return null;

  const typeClass = {
    success: styles.toastSuccess,
    error: styles.toastError,
    info: styles.toastInfo,
    warning: styles.toastWarning,
  }[toast.type];

  return (
    <div
      class={`${styles.toast} ${typeClass} ${exiting ? styles.toastExit : ""}`}
      role="alert"
    >
      <span class={styles.toastMessage}>{toast.message}</span>
      <button
        class={styles.toastDismiss}
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div class={styles.toastContainer} aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

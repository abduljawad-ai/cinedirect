export function scrollToTop(behavior: ScrollBehavior = "smooth"): void {
  if (typeof window === "undefined") return;
  window.scrollTo({ top: 0, behavior });
}

export function focusElement(el: HTMLElement | null): void {
  if (!el) return;
  el.focus();
}

export function afterPaint(cb: () => void): void {
  if (typeof requestAnimationFrame === "undefined") {
    cb();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(cb));
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !("matchMedia" in window)) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function createObserver(
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  return new IntersectionObserver(callback, options);
}

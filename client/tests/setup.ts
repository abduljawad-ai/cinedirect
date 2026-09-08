/** Test setup: global mocks loaded before every Vitest run. */

// Polyfill crypto.randomUUID if missing (used by the toast store).
if (typeof globalThis.crypto === 'undefined') {
  (globalThis as any).crypto = {};
}
if (!('randomUUID' in globalThis.crypto)) {
  (globalThis.crypto as any).randomUUID = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Mock IntersectionObserver (used by lazy-loading helpers) if missing.
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds = [0];
  }
  (globalThis as any).IntersectionObserver = MockIntersectionObserver;
}

// Mock matchMedia if missing.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

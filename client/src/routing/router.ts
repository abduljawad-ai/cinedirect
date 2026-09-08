import type { Route } from "@shared/types";

const DETAIL_RE = /^\/detail\/e(.+)$/;

export function parseHash(): Route {
  const raw = typeof location !== "undefined" ? location.hash : "";
  const path = raw.replace(/^#/, "");

  if (!path) return { view: "search", key: null };

  const m = DETAIL_RE.exec(path);
  if (m) {
    const key = m[1];
    if (key) {
      return { view: "detail", key };
    }
  }

  return { view: "search", key: null };
}

export interface RouterOptions {
  onRouteChange?: (route: Route) => void;
}

export class HashRouter {
  private currentRoute: Route;
  private onRouteChange?: (route: Route) => void;
  private listener: () => void;

  constructor(options?: RouterOptions) {
    this.onRouteChange = options?.onRouteChange;
    this.currentRoute = parseHash();
    this.listener = () => {
      this.currentRoute = parseHash();
      this.onRouteChange?.(this.currentRoute);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", this.listener);
    }
  }

  getRoute(): Route {
    return this.currentRoute;
  }

  navigate(route: string): void {
    if (typeof window === "undefined") return;
    if (`#${route}` === window.location.hash) return;
    window.location.hash = route;
    this.currentRoute = parseHash();
    this.onRouteChange?.(this.currentRoute);
  }

  goBack(): void {
    if (typeof history === "undefined") return;
    history.back();
  }

  destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("hashchange", this.listener);
    }
    this.onRouteChange = undefined;
  }
}

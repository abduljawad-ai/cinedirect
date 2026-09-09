import { signal, computed } from "@preact/signals";
import type {
  ShowGroup,
  Post,
  AppMode,
  Toast,
  Route,
  EditionIndexEntry,
  TvMazeMeta,
  QualityRow,
  HubLink,
} from "@shared/types";

/** Per-edition detail view state (loaded lazily when a detail route opens). */
export interface DetailState {
  key: string | null; // decoded edition key currently on screen
  loading: boolean;
  meta: TvMazeMeta | null;
  rows: QualityRow[];
  error: string | null;
  /** True while download links are still being resolved. */
  resolving: boolean;
  /** Hubs whose links are still resolving — rendered as skeleton rows. */
  pending: HubLink[];
}

export const groupsSignal = signal<ShowGroup[]>([]);
export const postsSignal = signal<Post[]>([]);
export const querySignal = signal<string>("");
export const modeSignal = signal<AppMode>("static");
export const editionsSignal = signal<Record<string, EditionIndexEntry>>({});
export const currentKeySignal = signal<string | null>(null);
export const toastsSignal = signal<Toast[]>([]);
export const loadingSignal = signal<boolean>(false);
export const routeSignal = signal<Route>({ view: "search", key: null });
export const detailStateSignal = signal<DetailState>({
  key: null,
  loading: false,
  meta: null,
  rows: [],
  error: null,
  resolving: false,
  pending: [],
});

export const hasResults = computed(() => groupsSignal.value.length > 0);
export const totalPosts = computed(() => {
  return groupsSignal.value.reduce((n, g) => n + g.items.length, 0);
});

export function setResults(
  groups: ShowGroup[],
  posts: Post[],
  query: string,
): void {
  groupsSignal.value = groups;
  postsSignal.value = posts;
  querySignal.value = query;
}

export function setLoading(value: boolean): void {
  loadingSignal.value = value;
}

export function setMode(mode: AppMode): void {
  modeSignal.value = mode;
}

export function showToast(
  type: Toast["type"],
  message: string,
  duration = 5000,
): void {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  toastsSignal.value = [...toastsSignal.value, { id, type, message, duration }];
}

export function dismissToast(id: string): void {
  toastsSignal.value = toastsSignal.value.filter((t) => t.id !== id);
}

export function setRoute(route: Route): void {
  routeSignal.value = route;
}

/** Update the detail view state (loading / meta / rows / error). */
export function setDetailState(patch: Partial<DetailState>): void {
  detailStateSignal.value = { ...detailStateSignal.value, ...patch };
}

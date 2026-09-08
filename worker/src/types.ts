export type Quality = '2160P' | '4K' | '1080P' | '720P' | '480P' | '360P';

export interface ResolveResult {
  direct: string | null;
  size: number | null;
  filename: string | null;
  quality: Quality | null;
}

export interface Env {
  ALLOWED_ORIGINS?: string;
}

export interface FileInfo {
  size: number | null;
  filename: string;
}

export function parseAdminEmails(input: unknown): string[];
export function normalizeDomain(domain: string): string;
export function deriveBucketName(projectName: string): string;
export function deriveDbName(projectName: string): string;
export function deriveKvName(projectName: string): string;
export function updateWranglerToml(content: string, values: Record<string, unknown>): string;

export interface Deps {
  fs: {
    readFile: (path: string, encoding?: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  wrangler: (
    args: string[],
    opts?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  api: (
    method: string,
    path: string,
    body?: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<Record<string, unknown>> }>;
  prompt: (message: string, defaultValue?: string) => Promise<string>;
  confirm: (message: string, defaultValue?: boolean) => Promise<boolean>;
  log: (message: string) => void;
  pause: (message: string) => Promise<void>;
  env?: Record<string, string>;
}

export function runSetup(options: Record<string, unknown>, deps: Deps): Promise<void>;

export function parseAdminEmails(input: unknown): string[];
export function parseTruthy(value: unknown): boolean | undefined;
export function envToSetupOptions(env: Record<string, string | undefined>): {
  workerDomain: string | undefined;
  cdnDomain: string | undefined;
  projectName: string | undefined;
  adminEmails: string | undefined;
  headless: boolean;
  createKv?: boolean;
};
export function normalizeDomain(domain: string): string;
export function deriveBucketName(projectName: string): string;
export function deriveDbName(projectName: string): string;
export function deriveKvName(projectName: string): string;
export function updateWranglerToml(content: string, values: Record<string, unknown>): string;

export function wranglerConfigPaths(
  env?: Record<string, string | undefined>,
  osInfo?: { homedir?: () => string; platform?: () => string },
): string[];
export function parseOauthToken(tomlContent: string | null | undefined): string | undefined;
export function resolveWranglerAuthToken(
  paths: string[],
  readFile: (path: string, encoding?: string) => Promise<string>,
): Promise<{ token: string | undefined; path: string | undefined }>;
export function findEncryptedWranglerConfig(
  paths: string[],
  stat: (path: string) => Promise<unknown>,
): Promise<string | undefined>;
export function describeApiError(
  response: { status: number; json: () => Promise<unknown> },
  fallback: string,
): Promise<string>;
export function createApiClient(options: {
  env?: Record<string, string | undefined>;
  oauthToken?: string;
  resolveOauthToken?: () => Promise<{ token: string | undefined } | undefined>;
  fetchImpl?: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}): (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ ok: boolean; status: number; json: () => Promise<Record<string, unknown>> }>;

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

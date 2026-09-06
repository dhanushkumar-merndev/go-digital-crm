export type LocalEnvironment = Record<string, string>;

export interface DatabaseProbeResult {
  resource: string;
  ready: boolean;
  status: number | string;
}

export function loadLocalEnvironment(
  root?: string,
  runtime?: Record<string, string | undefined>,
): Promise<LocalEnvironment>;

export function configurationProblems(env: LocalEnvironment): string[];

export function initializeLocalSecrets(
  root?: string,
  runtime?: Record<string, string | undefined>,
): Promise<boolean>;

export function probeDatabase(
  env: LocalEnvironment,
  request?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): Promise<DatabaseProbeResult[]>;

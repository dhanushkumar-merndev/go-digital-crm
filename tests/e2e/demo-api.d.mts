export function demoJson(response: Response): Promise<unknown>;

export function createDemoSessionProvider(options: {
  projectUrl?: string;
  anonKey?: string;
  password?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): (roleKey: string) => Promise<string>;

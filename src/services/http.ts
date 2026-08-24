import type { Logger } from "pino";

export type QueryValue = string | number | boolean | Array<string | number | boolean> | undefined;

export type MediaRequestOptions = {
  service: string;
  logService?: string;
  method?: string;
  baseUrl: string;
  path: string;
  logPath?: string;
  timeoutSeconds: number;
  headers?: Record<string, string>;
  body?: unknown;
  responseType: "json" | "text";
  logger?: Logger;
};

export async function requestMedia<T>(options: MediaRequestOptions): Promise<T> {
  const method = options.method ?? "GET";
  const logPath = options.logPath ?? options.path;
  const url = new URL(options.path, ensureTrailingSlash(options.baseUrl));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  const startedAt = Date.now();
  let response: Response;

  options.logger?.info(
    {
      service: options.logService ?? options.service,
      method,
      path: logPath,
      timeoutSeconds: options.timeoutSeconds,
    },
    "Media service request started",
  );

  try {
    response = await fetch(url, {
      method,
      headers: {
        ...options.headers,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      options.logger?.warn(
        {
          service: options.logService ?? options.service,
          method,
          path: logPath,
          timeoutSeconds: options.timeoutSeconds,
          elapsedMs,
        },
        "Media service request timed out",
      );
      throw new Error(`${options.service} request timed out after ${options.timeoutSeconds} seconds: ${logPath}`);
    }

    options.logger?.warn(
      {
        service: options.logService ?? options.service,
        method,
        path: logPath,
        timeoutSeconds: options.timeoutSeconds,
        elapsedMs,
        error: error instanceof Error ? error.message : String(error),
      },
      "Media service request failed before response",
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = await response.text();
    options.logger?.warn(
      {
        service: options.logService ?? options.service,
        method,
        path: logPath,
        timeoutSeconds: options.timeoutSeconds,
        elapsedMs,
        status: response.status,
        statusText: response.statusText,
        server: response.headers.get("server") ?? undefined,
        via: response.headers.get("via") ?? undefined,
        bodyPreview: body.slice(0, 500) || undefined,
      },
      "Media service request returned non-OK response",
    );
    throw new Error(`${options.service} request failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }

  options.logger?.info(
    {
      service: options.logService ?? options.service,
      method,
      path: logPath,
      timeoutSeconds: options.timeoutSeconds,
      elapsedMs,
      status: response.status,
    },
    "Media service request completed",
  );

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.text();
  if (options.responseType === "text") return body as T;
  return (body.trim() ? JSON.parse(body) : undefined) as T;
}

export function buildQueryPath(path: string, params: Record<string, QueryValue>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      searchParams.append(key, String(item));
    }
  }

  const query = searchParams.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

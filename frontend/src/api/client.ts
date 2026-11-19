import { config } from "@/lib/config";
import {
  ERROR_CODES,
  MAX_ADVERSARIAL_TRIALS,
  SCHEMA_VERSION,
  type AdversarialRequest,
  type AdversarialResponse,
  type ApiErrorBody,
  type CaseDetail,
  type CaseListResponse,
  type CounterfactualRequest,
  type CounterfactualResponse,
  type DecisionRequest,
  type DecisionResponse,
  type InvestigateRequest,
  type InvestigateResponse,
  type ReportResponse,
  type UploadResponse,
} from "./types";

/** Single error type for every failure path, so screens render errors uniformly. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly requestId: string | null,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isBudgetExhausted = (e: unknown): boolean =>
  e instanceof ApiError && e.code === ERROR_CODES.BUDGET_EXHAUSTED;

/** One key per user-initiated investigation; reuse it on retry so budget is not spent twice. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

type Method = "GET" | "POST";
interface RequestOptions {
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkVersion(data: Record<string, unknown>, status: number): void {
  const version = data.schema_version;
  if (typeof version !== "string" || version.split(".")[0] !== SCHEMA_VERSION.split(".")[0]) {
    throw new ApiError(
      `Unsupported API schema version: ${String(version)} (expected ${SCHEMA_VERSION})`,
      "schema_mismatch",
      status,
      typeof data.request_id === "string" ? data.request_id : null,
    );
  }
}

/** Parses a response (real or mocked) into typed data or throws ApiError. */
export function parseResponse<T>(status: number, data: unknown): T {
  if (!isRecord(data)) {
    throw new ApiError("The server returned an unreadable response.", "invalid_response", status, null);
  }
  if (status < 200 || status >= 300) {
    const err = (data as Partial<ApiErrorBody>).error;
    throw new ApiError(
      err?.message ?? `Request failed with status ${status}.`,
      err?.code ?? "http_error",
      status,
      typeof data.request_id === "string" ? data.request_id : null,
      err?.details,
    );
  }
  checkVersion(data, status);
  return data as T;
}

async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  if (config.useMocks) {
    // Explicit opt-in only. Real-API failures below never reach this branch.
    const { handleMock } = await import("./mocks/handler");
    // The mock honours AbortSignal like fetch does, so timeouts and navigation cancel it the same way.
    const abort = (): DOMException => new DOMException("Aborted", "AbortError");
    if (opts.signal?.aborted) throw abort();
    const { status, data } = await new Promise<Awaited<ReturnType<typeof handleMock>>>((resolve, reject) => {
      const onAbort = () => reject(abort());
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      handleMock(method, path, opts.body, opts.form).then(resolve, reject).finally(() => opts.signal?.removeEventListener("abort", onAbort));
    });
    return parseResponse<T>(status, data);
  }

  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      signal: opts.signal,
      headers: opts.form || opts.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError("Could not reach the SOC Sentinel API.", "network_error", null, null);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError("The server returned a non-JSON response.", "invalid_response", res.status, null);
  }
  return parseResponse<T>(res.status, data);
}

const enc = encodeURIComponent;

export const api = {
  upload: (file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append("file", file);
    return request<UploadResponse>("POST", "/api/upload", { form, signal });
  },
  listCases: (signal?: AbortSignal) => request<CaseListResponse>("GET", "/api/cases", { signal }),
  getCase: (id: string, signal?: AbortSignal) =>
    request<CaseDetail>("GET", `/api/cases/${enc(id)}`, { signal }),
  getReport: (id: string, signal?: AbortSignal) =>
    request<ReportResponse>("GET", `/api/cases/${enc(id)}/report`, { signal }),
  counterfactual: (id: string, body: CounterfactualRequest, signal?: AbortSignal) =>
    request<CounterfactualResponse>("POST", `/api/cases/${enc(id)}/counterfactual`, { body, signal }),
  investigate: (id: string, body: InvestigateRequest, signal?: AbortSignal) =>
    request<InvestigateResponse>("POST", `/api/cases/${enc(id)}/investigate`, { body, signal }),
  runAdversarial: (body: AdversarialRequest, signal?: AbortSignal) => {
    if (!Number.isInteger(body.trials) || body.trials < 1 || body.trials > MAX_ADVERSARIAL_TRIALS) {
      return Promise.reject(
        new ApiError(`Trials must be an integer from 1 to ${MAX_ADVERSARIAL_TRIALS}.`, "invalid_request", null, null),
      );
    }
    return request<AdversarialResponse>("POST", "/api/adversarial/run", { body, signal });
  },
  decide: (id: string, body: DecisionRequest, signal?: AbortSignal) =>
    request<DecisionResponse>("POST", `/api/cases/${enc(id)}/decision`, { body, signal }),
};

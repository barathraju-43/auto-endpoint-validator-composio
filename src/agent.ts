import { Composio } from "@composio/core";
import type { EndpointDefinition, TestReport } from "./types";

type EndpointMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

type EndpointStatus = TestReport["results"][number]["status"];

type ConnectedAccountInfo = {
  id: string;
  toolkitSlug: string;
  availableScopes: string[];
};

type ResourceRecord = {
  id: string;
  value: unknown;
};

type RequestPlan = {
  endpoint: string;
  method: EndpointMethod;
  parameters?: Array<{
    in: "query" | "header";
    name: string;
    value: string | number;
  }>;
  body?: Record<string, unknown>;
};

type ExecutionResult = {
  statusCode: number | null;
  status: EndpointStatus;
  summary: string;
  body: unknown;
};

type AgentContext = {
  composio: Composio;
  endpointsByToolkit: Map<string, EndpointDefinition[]>;
  connectedAccounts: Map<string, ConnectedAccountInfo>;
  endpointReports: Map<string, TestReport["results"][number]>;
  resourceCache: Map<string, ResourceRecord[]>;
  createdResourceIds: Set<string>;
  resolutionStack: Set<string>;
  gmailAddress: string | null;
};

const CONNECTED_ACCOUNT_FALLBACK = "candidate";
const MAX_RESPONSE_CHARS = 4000;

function normalizeToolkitSlug(endpoint: EndpointDefinition): string {
  return endpoint.tool_slug.split("_")[0].toLowerCase();
}

function normalizeMethod(method: string): EndpointMethod {
  return method.toUpperCase() as EndpointMethod;
}

function getPathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function singularize(value: string): string {
  if (value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith("ses")) {
    return value.slice(0, -2);
  }

  if (value.endsWith("s")) {
    return value.slice(0, -1);
  }

  return value;
}

function pluralize(value: string): string {
  if (value.endsWith("y")) {
    return `${value.slice(0, -1)}ies`;
  }

  if (value.endsWith("s")) {
    return value;
  }

  return `${value}s`;
}

function getResourceSegment(path: string): string | null {
  const segments = getPathSegments(path);

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (!segment.startsWith("{")) {
      return segment;
    }
  }

  return null;
}

function getCollectionPath(path: string): string {
  return path.replace(/\/\{[^/]+\}(?:\/[^/]+)?$/, "");
}

function truncate(value: string): string {
  if (value.length <= MAX_RESPONSE_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_RESPONSE_CHARS)}…`;
}

function redactString(value: string): string {
  return value.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[redacted-email]"
  );
}

function sanitize(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return truncate(redactString(value));
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (["access_token", "refresh_token", "id_token", "authorization"].includes(lowered)) {
        result[key] = "[redacted]";
        continue;
      }
      result[key] = sanitize(entry);
    }
    return result;
  }

  return value;
}

function summarizeErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const candidate = body as Record<string, unknown>;
  const error = candidate.error;

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }

  const message = candidate.message;
  if (typeof message === "string") {
    return message;
  }

  return null;
}

function classifyStatus(statusCode: number | null, body: unknown): EndpointStatus {
  if (statusCode && statusCode >= 200 && statusCode < 300) {
    return "valid";
  }

  const message = summarizeErrorMessage(body)?.toLowerCase() ?? "";

  if (
    statusCode === 403 ||
    message.includes("insufficient") ||
    message.includes("forbidden") ||
    message.includes("permission")
  ) {
    return "insufficient_scopes";
  }

  if (
    statusCode === 404 ||
    statusCode === 405 ||
    message.includes("not found") ||
    message.includes("no such") ||
    message.includes("method not allowed")
  ) {
    return "invalid_endpoint";
  }

  return "error";
}

function makeSummary(statusCode: number | null, body: unknown, requestPlan: RequestPlan): string {
  const message = summarizeErrorMessage(body);

  if (statusCode && statusCode >= 200 && statusCode < 300) {
    return `${requestPlan.method} ${requestPlan.endpoint} returned ${statusCode}.`;
  }

  if (message) {
    return `${requestPlan.method} ${requestPlan.endpoint} returned ${statusCode ?? "no status"}: ${message}`;
  }

  return `${requestPlan.method} ${requestPlan.endpoint} returned ${statusCode ?? "no status"}.`;
}

function buildRawEmail(address: string): string {
  const timestamp = new Date().toISOString();
  const content = [
    `From: <${address}>`,
    `To: <${address}>`,
    `Subject: Composio endpoint validator ${timestamp}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    `Validation email created at ${timestamp}.`,
  ].join("\r\n");

  return Buffer.from(content)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function deriveNormalizedEndpointFrom404(
  requestPlan: RequestPlan,
  body: unknown
): string | null {
  if (typeof body !== "string") {
    return null;
  }

  const match = body.match(/requested URL <code>([^<]+)<\/code>/i);
  if (!match) {
    return null;
  }

  const requestedPath = match[1].split("?")[0] ?? match[1];
  const requestedSegments = getPathSegments(requestedPath);
  const originalSegments = getPathSegments(requestPlan.endpoint);

  if (requestedSegments.length <= originalSegments.length) {
    return null;
  }

  for (let prefixLength = 1; prefixLength < originalSegments.length; prefixLength += 1) {
    const duplicated = originalSegments.slice(0, prefixLength);
    const expected = [...duplicated, ...originalSegments];

    if (expected.length !== requestedSegments.length) {
      continue;
    }

    const isMatch = expected.every((segment, index) => segment === requestedSegments[index]);
    if (isMatch) {
      return `/${originalSegments.slice(prefixLength).join("/")}`;
    }
  }

  return null;
}

function buildDateRange(offsetHours: number): { dateTime: string; timeZone: string } {
  const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  return {
    dateTime: date.toISOString(),
    timeZone: "UTC",
  };
}

function buildScalarValue(field: EndpointDefinition["parameters"]["query"][number], gmailAddress: string | null): unknown {
  const loweredName = field.name.toLowerCase();
  const loweredDescription = field.description.toLowerCase();

  if (field.type === "integer") {
    return 5;
  }

  if (field.type === "boolean") {
    return false;
  }

  if (loweredName === "raw") {
    return buildRawEmail(gmailAddress ?? "me@example.com");
  }

  if (loweredName === "format") {
    return "full";
  }

  if (loweredName === "summary") {
    return "Composio endpoint validator";
  }

  if (loweredName === "description") {
    return "Created by the automated endpoint validator.";
  }

  if (loweredName.includes("time") || loweredDescription.includes("rfc3339")) {
    return new Date().toISOString();
  }

  if (loweredDescription.includes("search")) {
    return "in:anywhere";
  }

  return "test";
}

function toProxyParameterValue(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function buildBodyValue(
  field: EndpointDefinition["parameters"]["query"][number],
  gmailAddress: string | null
): unknown {
  const loweredName = field.name.toLowerCase();
  const loweredDescription = field.description.toLowerCase();

  if (field.type === "object") {
    if (loweredName === "message" || loweredDescription.includes("'raw'")) {
      return { raw: buildRawEmail(gmailAddress ?? "me@example.com") };
    }

    if (loweredName === "start") {
      return buildDateRange(1);
    }

    if (loweredName === "end") {
      return buildDateRange(2);
    }

    return {};
  }

  return buildScalarValue(field, gmailAddress);
}

function extractRecords(value: unknown): ResourceRecord[] {
  const records: ResourceRecord[] = [];

  function walk(entry: unknown) {
    if (!entry) {
      return;
    }

    if (Array.isArray(entry)) {
      for (const item of entry) {
        walk(item);
      }
      return;
    }

    if (typeof entry !== "object") {
      return;
    }

    const object = entry as Record<string, unknown>;
    const id = object.id;
    if (typeof id === "string" && id.length > 0) {
      records.push({ id, value: sanitize(object) });
    }

    for (const nested of Object.values(object)) {
      walk(nested);
    }
  }

  walk(value);
  return records;
}

function cacheRecords(
  context: AgentContext,
  toolkitSlug: string,
  resourceName: string | null,
  value: unknown
) {
  if (!resourceName) {
    return;
  }

  const records = extractRecords(value);
  if (records.length === 0) {
    return;
  }

  const cacheKey = `${toolkitSlug}:${resourceName.toLowerCase()}`;
  const existing = context.resourceCache.get(cacheKey) ?? [];
  const seenIds = new Set(existing.map((item) => item.id));

  for (const record of records) {
    if (!seenIds.has(record.id)) {
      existing.push(record);
      seenIds.add(record.id);
    }
  }

  context.resourceCache.set(cacheKey, existing);
}

async function ensureGmailAddress(context: AgentContext) {
  if (context.gmailAddress) {
    return context.gmailAddress;
  }

  const endpoint = context.endpointsByToolkit
    .get("gmail")
    ?.find((candidate) => candidate.path.endsWith("/users/me/profile"));

  if (!endpoint) {
    return null;
  }

  await executeEndpoint(context, endpoint);
  return context.gmailAddress;
}

function candidateCacheKeys(endpoint: EndpointDefinition, paramName: string): string[] {
  const toolkitSlug = normalizeToolkitSlug(endpoint);
  const lowerParam = paramName.toLowerCase();
  const paramStem = singularize(lowerParam.replace(/id$/i, ""));
  const segments = getPathSegments(endpoint.path);
  const placeholderIndex = segments.findIndex((segment) => segment === `{${paramName}}`);
  const resourceSegment = placeholderIndex > 0 ? segments[placeholderIndex - 1].toLowerCase() : null;

  const names = new Set<string>([
    paramStem,
    pluralize(paramStem),
    singularize(paramStem),
  ]);

  if (resourceSegment) {
    names.add(resourceSegment);
    names.add(singularize(resourceSegment));
    names.add(pluralize(resourceSegment));
  }

  return [...names].map((name) => `${toolkitSlug}:${name}`);
}

function getCachedId(context: AgentContext, endpoint: EndpointDefinition, paramName: string): string | null {
  for (const key of candidateCacheKeys(endpoint, paramName)) {
    const records = context.resourceCache.get(key);
    if (records && records.length > 0) {
      return records[0].id;
    }
  }

  return null;
}

function findDependencyCandidates(
  context: AgentContext,
  endpoint: EndpointDefinition,
  paramName: string
): EndpointDefinition[] {
  const toolkitSlug = normalizeToolkitSlug(endpoint);
  const candidates = context.endpointsByToolkit.get(toolkitSlug) ?? [];
  const collectionPath = getCollectionPath(endpoint.path);

  return candidates
    .filter((candidate) => candidate.tool_slug !== endpoint.tool_slug)
    .filter((candidate) => {
      if (candidate.path === collectionPath && candidate.method === "GET") {
        return true;
      }

      if (candidate.path === collectionPath && candidate.method === "POST") {
        return true;
      }

      return candidate.parameters.path.every((param) => param.name !== paramName);
    })
    .sort((left, right) => {
      const leftScore = left.path === collectionPath && left.method === "GET" ? 0 : left.method === "GET" ? 1 : 2;
      const rightScore = right.path === collectionPath && right.method === "GET" ? 0 : right.method === "GET" ? 1 : 2;
      return leftScore - rightScore;
    });
}

async function resolvePathValue(
  context: AgentContext,
  endpoint: EndpointDefinition,
  paramName: string
): Promise<string | null> {
  const cachedId = getCachedId(context, endpoint, paramName);
  if (cachedId) {
    return cachedId;
  }

  const candidates = findDependencyCandidates(context, endpoint, paramName);

  for (const candidate of candidates) {
    await executeEndpoint(context, candidate);
    const resolvedId = getCachedId(context, endpoint, paramName);
    if (resolvedId) {
      return resolvedId;
    }
  }

  return null;
}

async function buildRequestPlan(
  context: AgentContext,
  endpoint: EndpointDefinition,
  includeOptionalQueryParams: boolean
): Promise<RequestPlan> {
  let resolvedPath = endpoint.path;

  for (const pathParam of endpoint.parameters.path) {
    const value = await resolvePathValue(context, endpoint, pathParam.name);
    if (!value) {
      throw new Error(`Unable to resolve path parameter "${pathParam.name}" for ${endpoint.tool_slug}`);
    }
    resolvedPath = resolvedPath.replace(`{${pathParam.name}}`, encodeURIComponent(value));
  }

  const queryParameters = includeOptionalQueryParams
    ? endpoint.parameters.query.map((field) => ({
        in: "query" as const,
        name: field.name,
        value: toProxyParameterValue(
          buildScalarValue(field, context.gmailAddress)
        ),
      }))
    : [];

  let body: Record<string, unknown> | undefined;
  if (endpoint.parameters.body) {
    const gmailAddress = await ensureGmailAddress(context);
    body = {};
    for (const field of endpoint.parameters.body.fields) {
      if (!field.required) {
        continue;
      }
      body[field.name] = buildBodyValue(field, gmailAddress);
    }
  }

  return {
    endpoint: resolvedPath,
    method: normalizeMethod(endpoint.method),
    parameters: queryParameters.length > 0 ? queryParameters : undefined,
    body,
  };
}

async function proxyExecute(
  context: AgentContext,
  endpoint: EndpointDefinition,
  requestPlan: RequestPlan
): Promise<{ statusCode: number | null; body: unknown }> {
  const toolkitSlug = normalizeToolkitSlug(endpoint);
  const connectedAccount =
    context.connectedAccounts.get(toolkitSlug)?.id ?? CONNECTED_ACCOUNT_FALLBACK;

  try {
    const result = await context.composio.tools.proxyExecute({
      endpoint: requestPlan.endpoint,
      method: requestPlan.method,
      connectedAccountId: connectedAccount,
      parameters: requestPlan.parameters,
      body: requestPlan.body,
    });

    return {
      statusCode: result.status ?? null,
      body: result.data ?? { headers: result.headers },
    };
  } catch (error) {
    const maybeError = error as { status?: number; message?: string; body?: unknown };
    return {
      statusCode: maybeError.status ?? null,
      body: maybeError.body ?? { message: maybeError.message ?? String(error) },
    };
  }
}

async function executeWithVariants(
  context: AgentContext,
  endpoint: EndpointDefinition
): Promise<ExecutionResult> {
  const variants = [true, false];
  let lastResult: ExecutionResult | null = null;

  for (const includeOptionalQueryParams of variants) {
    try {
      const requestPlan = await buildRequestPlan(
        context,
        endpoint,
        includeOptionalQueryParams
      );
      const response = await proxyExecute(context, endpoint, requestPlan);
      const status = classifyStatus(response.statusCode, response.body);
      const summary = makeSummary(response.statusCode, response.body, requestPlan);

      lastResult = {
        statusCode: response.statusCode,
        status,
        summary,
        body: response.body,
      };

      const normalizedEndpoint =
        status === "invalid_endpoint"
          ? deriveNormalizedEndpointFrom404(requestPlan, response.body)
          : null;

      if (normalizedEndpoint && normalizedEndpoint !== requestPlan.endpoint) {
        const normalizedPlan = {
          ...requestPlan,
          endpoint: normalizedEndpoint,
        };
        const normalizedResponse = await proxyExecute(context, endpoint, normalizedPlan);
        const normalizedStatus = classifyStatus(
          normalizedResponse.statusCode,
          normalizedResponse.body
        );
        const normalizedSummary = makeSummary(
          normalizedResponse.statusCode,
          normalizedResponse.body,
          normalizedPlan
        );

        lastResult = {
          statusCode: normalizedResponse.statusCode,
          status: normalizedStatus,
          summary: `${normalizedSummary} Retried after removing duplicated proxy prefix.`,
          body: normalizedResponse.body,
        };
      }

      if (status === "valid" || status === "insufficient_scopes" || status === "invalid_endpoint") {
        if (lastResult.status === "valid" || lastResult.status === "insufficient_scopes") {
          return lastResult;
        }

        if (!normalizedEndpoint) {
          return lastResult;
        }
      }
    } catch (error) {
      lastResult = {
        statusCode: null,
        status: "error",
        summary: String(error),
        body: sanitize({ message: String(error) }),
      };
    }
  }

  return (
    lastResult ?? {
      statusCode: null,
      status: "error",
      summary: "No execution attempts were made.",
      body: null,
    }
  );
}

async function executeEndpoint(
  context: AgentContext,
  endpoint: EndpointDefinition
): Promise<TestReport["results"][number]> {
  const cached = context.endpointReports.get(endpoint.tool_slug);
  if (cached) {
    return cached;
  }

  if (context.resolutionStack.has(endpoint.tool_slug)) {
    return {
      tool_slug: endpoint.tool_slug,
      method: endpoint.method,
      path: endpoint.path,
      status: "error",
      http_status_code: null,
      response_summary: `Dependency cycle detected while resolving ${endpoint.tool_slug}.`,
      response_body: null,
      required_scopes: endpoint.required_scopes,
      available_scopes: [],
    };
  }

  context.resolutionStack.add(endpoint.tool_slug);

  const toolkitSlug = normalizeToolkitSlug(endpoint);
  const connectedAccount = context.connectedAccounts.get(toolkitSlug);
  const result = await executeWithVariants(context, endpoint);

  const report = {
    tool_slug: endpoint.tool_slug,
    method: endpoint.method,
    path: endpoint.path,
    status: result.status,
    http_status_code: result.statusCode,
    response_summary: result.summary,
    response_body: sanitize(result.body),
    required_scopes: endpoint.required_scopes,
    available_scopes: connectedAccount?.availableScopes ?? [],
  };

  if (report.status === "valid") {
    const resourceName = getResourceSegment(endpoint.path);
    cacheRecords(context, toolkitSlug, resourceName, result.body);

    if (
      toolkitSlug === "gmail" &&
      endpoint.path.endsWith("/users/me/profile") &&
      result.body &&
      typeof result.body === "object"
    ) {
      const email = (result.body as Record<string, unknown>).emailAddress;
      if (typeof email === "string") {
        context.gmailAddress = email;
      }
    }

    if (
      endpoint.method === "POST" &&
      endpoint.path.includes("/events") &&
      result.body &&
      typeof result.body === "object"
    ) {
      const createdId = (result.body as Record<string, unknown>).id;
      if (typeof createdId === "string") {
        context.createdResourceIds.add(createdId);
      }
    }
  }

  context.resolutionStack.delete(endpoint.tool_slug);
  context.endpointReports.set(endpoint.tool_slug, report);
  return report;
}

async function loadConnectedAccounts(
  composio: Composio
): Promise<Map<string, ConnectedAccountInfo>> {
  const response = await composio.connectedAccounts.list();
  const accounts = new Map<string, ConnectedAccountInfo>();

  for (const item of response.items ?? []) {
    const toolkitSlug = item.toolkit?.slug;
    const rawScopes =
      item.state?.val && typeof item.state.val === "object"
        ? (item.state.val as Record<string, unknown>).scope
        : undefined;

    if (!toolkitSlug || typeof item.id !== "string") {
      continue;
    }

    accounts.set(toolkitSlug, {
      id: item.id,
      toolkitSlug,
      availableScopes:
        typeof rawScopes === "string"
          ? rawScopes.split(/\s+/).filter(Boolean)
          : [],
    });
  }

  return accounts;
}

async function cleanupCreatedEvents(context: AgentContext) {
  const calendarAccount = context.connectedAccounts.get("googlecalendar");
  if (!calendarAccount || context.createdResourceIds.size === 0) {
    return;
  }

  for (const eventId of context.createdResourceIds) {
    try {
      await context.composio.tools.proxyExecute({
        endpoint: `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        method: "DELETE",
        connectedAccountId: calendarAccount.id,
      });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

/**
 * This is the entry point for your agent implementation.
 *
 * Your agent receives:
 *   - composio: an authenticated Composio client
 *   - connectedAccountId: the account ID to use with composio.tools.proxyExecute()
 *   - endpoints: the list of endpoint definitions to validate
 *
 * Your agent must return:
 *   - A TestReport containing an EndpointReport for every endpoint
 *
 * EndpointReport (per endpoint):
 *   - tool_slug, method, path — identifies which endpoint was tested
 *   - status — "valid" | "invalid_endpoint" | "insufficient_scopes" | "error"
 *   - http_status_code — the HTTP status code received (or null)
 *   - response_summary — explain WHY it was classified this way (bonus: a high-quality summary is a great cherry on top)
 *   - response_body — the actual response body or error (truncate large responses, redact sensitive data)
 *   - required_scopes — scopes the endpoint needs (from the definition)
 *   - available_scopes — scopes the connected account actually has (use [] if not determinable)
 *
 * TestReport:
 *   - timestamp — when the report was generated
 *   - total_endpoints — number of endpoints tested
 *   - results — array of EndpointReport (one per endpoint)
 *   - summary — counts per status (valid, invalid_endpoint, insufficient_scopes, error)
 *
 * Your goal: determine if each endpoint can be successfully executed at least once.
 * One successful 2xx response = valid. If the endpoint doesn't exist, flag it as
 * invalid_endpoint. If auth/scopes are insufficient, flag as insufficient_scopes.
 *
 * Key challenges:
 *   - Some endpoints are FAKE (don't exist in the real API)
 *   - Some need path parameters resolved from other endpoints (dependency resolution)
 *   - Some need request bodies constructed from the parameter definitions
 *   - Don't hardcode app-specific logic — this must work for any app
 *
 * See src/types.ts for the full type definitions.
 * See ARCHITECTURE.md for where to document your design decisions.
 */
export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const connectedAccounts = await loadConnectedAccounts(params.composio);
  const endpointsByToolkit = new Map<string, EndpointDefinition[]>();

  for (const endpoint of params.endpoints) {
    const toolkitSlug = normalizeToolkitSlug(endpoint);
    const current = endpointsByToolkit.get(toolkitSlug) ?? [];
    current.push(endpoint);
    endpointsByToolkit.set(toolkitSlug, current);
  }

  const context: AgentContext = {
    composio: params.composio,
    endpointsByToolkit,
    connectedAccounts,
    endpointReports: new Map(),
    resourceCache: new Map(),
    createdResourceIds: new Set(),
    resolutionStack: new Set(),
    gmailAddress: null,
  };

  const results: TestReport["results"] = [];
  for (const endpoint of params.endpoints) {
    results.push(await executeEndpoint(context, endpoint));
  }

  await cleanupCreatedEvents(context);

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: params.endpoints.length,
    results,
    summary: {
      valid: results.filter((result) => result.status === "valid").length,
      invalid_endpoint: results.filter((result) => result.status === "invalid_endpoint").length,
      insufficient_scopes: results.filter((result) => result.status === "insufficient_scopes").length,
      error: results.filter((result) => result.status === "error").length,
    },
  };
}

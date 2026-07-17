export interface DomainStudioUnavailableState {
  title: string;
  detail: string;
  status: string;
}

interface StructuredApiError extends Error {
  code?: string;
  details?: unknown;
}

function structuredApiError(error: unknown): StructuredApiError | undefined {
  return error instanceof Error ? error as StructuredApiError : undefined;
}

function errorDetails(error: StructuredApiError): Record<string, unknown> | undefined {
  return error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
}

/**
 * Translate the runtime's distinct readiness failures into factual UI copy.
 * Acceptance: CFG-003, UI-007, E2E-003.
 */
export function domainStudioUnavailableState(error: unknown): DomainStudioUnavailableState {
  const apiError = structuredApiError(error);
  if (apiError?.code === 'DBT_FIRST_NOT_ENABLED') {
    return {
      title: 'Set up dbt-first modeling',
      detail: 'Domain Studio requires a connected dbt project with manifest v3 and dbt-first modeling enabled. Open Settings → Project & dbt to connect and apply the project.',
      status: 'Modeling mode · Not enabled',
    };
  }

  if (apiError?.code === 'DBT_MANIFEST_NOT_FOUND') {
    const details = errorDetails(apiError);
    const configuredPath = typeof details?.manifestPath === 'string' && details.manifestPath.trim()
      ? details.manifestPath
      : 'target/manifest.json';
    return {
      title: 'dbt manifest is not ready',
      detail: `The dbt project is connected, but ${configuredPath} was not found. Run dbt parse, dbt compile, or dbt build in the configured dbt project, then refresh Domain Studio.`,
      status: `dbt manifest · Missing (${configuredPath})`,
    };
  }

  if (apiError?.code === 'DBT_MANIFEST_COMPILE_FAILED') {
    return {
      title: 'dbt manifest could not be loaded',
      detail: `${apiError.message} Rebuild the dbt manifest, then refresh Domain Studio.`,
      status: 'dbt manifest · Load failed',
    };
  }

  const message = error instanceof Error && error.message
    ? error.message
    : 'The local DQL notebook server did not return Domain Studio data.';
  return {
    title: 'Domain Studio could not load',
    detail: message,
    status: 'Domain Studio · Unavailable',
  };
}

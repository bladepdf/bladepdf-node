export class BladePdfError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MissingApiKeyError extends BladePdfError {}

export class InvalidRenderConfigurationError extends BladePdfError {}

export class AssetNotFoundError extends BladePdfError {}

export class AssetAccessDeniedError extends BladePdfError {}

export class UnableToWritePdfError extends BladePdfError {}

export interface RenderFailedErrorOptions extends ErrorOptions {
  statusCode?: number;
  requestId?: string;
  responseBody?: string;
}

export class RenderFailedError extends BladePdfError {
  public readonly statusCode: number | undefined;
  public readonly requestId: string | undefined;
  public readonly responseBody: string | undefined;

  public constructor(message: string, options: RenderFailedErrorOptions = {}) {
    super(message, options);
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
  }

  public static fromResponse(
    statusCode: number,
    responseBody: string,
    requestId?: string,
  ): RenderFailedError {
    const trimmed = responseBody.trim();
    const excerpt =
      trimmed.length > 1024 ? `${trimmed.slice(0, 1024)}…` : trimmed;
    const requestSuffix = requestId ? ` Request ID: ${requestId}.` : '';
    const bodySuffix = excerpt ? ` Response: ${excerpt}` : '';

    return new RenderFailedError(
      `BladePDF render request failed with status ${statusCode}.${requestSuffix}${bodySuffix}`,
      {
        statusCode,
        ...(requestId === undefined ? {} : { requestId }),
        responseBody,
      },
    );
  }

  public static fromTransport(
    message: string,
    cause: unknown,
  ): RenderFailedError {
    return new RenderFailedError(message, {
      cause,
    });
  }
}

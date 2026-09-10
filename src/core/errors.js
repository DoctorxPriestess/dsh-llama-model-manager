/**
 * Typed errors so the HTTP layer can map failures onto precise status codes,
 * and so the settings page can show actionable messages.
 */

/** 4xx: the user's configuration is wrong (bad model id, port conflict, ...). */
export class RequestError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', detail = {} } = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 404: unknown model id. */
export class UnknownModelError extends RequestError {
  constructor(modelId, available = []) {
    super(`未注册的模型 ID：${modelId}。可用模型：${available.join(', ') || '(无)'}`, {
      status: 404,
      code: 'UNKNOWN_MODEL',
      detail: { modelId, available },
    });
    this.name = 'UnknownModelError';
  }
}

/** 429: queue is full. */
export class QueueFullRequestError extends RequestError {
  constructor(message, detail = {}) {
    super(message, { status: 429, code: 'QUEUE_FULL', detail });
    this.name = 'QueueFullRequestError';
  }
}

/** 503: the model could not be brought up (startup failure, crash, shutdown). */
export class ModelUnavailableError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ModelUnavailableError';
    this.status = detail.status ?? 503;
    this.code = detail.code ?? 'MODEL_UNAVAILABLE';
    this.detail = detail;
  }
}

/** Fatal startup/health failure with everything the user needs to fix it. */
export class StartupFailure extends ModelUnavailableError {
  constructor(message, detail = {}) {
    super(message, { status: 503, code: 'STARTUP_FAILED', ...detail });
    this.name = 'StartupFailure';
  }
}

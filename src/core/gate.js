/**
 * ModelGate: the serialization core.
 *
 *  - Inference requests take a *shared* ticket (bounded by
 *    `maxConcurrentRequests`, default 1 -> strictly one proxied request at a time).
 *  - Model lifecycle transitions (load / unload / restart / switch) take an
 *    *exclusive* ticket: they wait for in-flight inference to drain and block
 *    new inference from starting, so the plugin can never stop a model while a
 *    request is being served, and can never run two models at once.
 *  - A bounded FIFO queue caps both kinds of waiters; overflow is a 429.
 *  - When in-flight requests refuse to drain, the exclusive waiter can force
 *    after `drainTimeoutMs` (spec: `forceShutdownAfterTimeout`) and the caller
 *    aborts the upstream requests instead of hard-killing mid-generation.
 */

export class QueueFullError extends Error {
  constructor(limit) {
    super(`请求队列已满（上限 ${limit}），请稍后重试。`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.limit = limit;
  }
}

export class GateAbortedError extends Error {
  constructor(reason = 'gate aborted') {
    super(reason);
    this.name = 'GateAbortedError';
    this.code = 'GATE_ABORTED';
  }
}

export class ModelGate {
  constructor({ maxConcurrentRequests = 1, maxQueuedRequests = 10, onQueueChange = null } = {}) {
    this.maxConcurrentRequests = Math.max(1, Number(maxConcurrentRequests) || 1);
    this.maxQueuedRequests = Math.max(0, Number(maxQueuedRequests) || 0);
    this.onQueueChange = onQueueChange;

    this._activeReaders = 0;
    this._exclusiveHeld = false;
    this._waitingReaders = [];
    this._waitingExclusives = [];
    this._aborted = false;
  }

  /** Reconfigure limits at runtime (settings page edits apply without restart). */
  configure({ maxConcurrentRequests, maxQueuedRequests }) {
    if (maxConcurrentRequests !== undefined) {
      this.maxConcurrentRequests = Math.max(1, Number(maxConcurrentRequests) || 1);
    }
    if (maxQueuedRequests !== undefined) {
      this.maxQueuedRequests = Math.max(0, Number(maxQueuedRequests) || 0);
    }
    this._drain();
  }

  get queueLength() {
    return this._waitingReaders.length + this._waitingExclusives.length;
  }

  get inflightCount() {
    return this._activeReaders;
  }

  get exclusiveHeld() {
    return this._exclusiveHeld;
  }

  /** Reject every queued waiter (manager shutdown). */
  abortAll(reason = 'manager shutting down') {
    this._aborted = true;
    const error = new GateAbortedError(reason);
    for (const waiter of [...this._waitingReaders, ...this._waitingExclusives]) {
      // Clear the drain deadline too: a rejected waiter must not leave a timer
      // behind (it is unref'd, so this is hygiene rather than a leak fix).
      if (waiter.drainTimer) {
        clearTimeout(waiter.drainTimer);
        waiter.drainTimer = null;
      }
      waiter.reject(error);
    }
    this._waitingReaders = [];
    this._waitingExclusives = [];
    this._notify();
  }

  /** Allow new work again (used by tests / restart of the manager). */
  reset() {
    this._aborted = false;
  }

  /**
   * Acquire a shared (inference) ticket.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<() => void>} release function
   */
  acquireInference({ signal } = {}) {
    if (this._aborted) return Promise.reject(new GateAbortedError('manager shutting down'));
    const canStartImmediately =
      !this._exclusiveHeld &&
      this._waitingExclusives.length === 0 &&
      this._activeReaders < this.maxConcurrentRequests;
    if (canStartImmediately) {
      this._activeReaders += 1;
      return Promise.resolve(this._makeRelease('read'));
    }
    if (this.queueLength >= this.maxQueuedRequests) {
      return Promise.reject(new QueueFullError(this.maxQueuedRequests));
    }
    return this._enqueue(this._waitingReaders, signal, 'read');
  }

  /**
   * Acquire the exclusive (lifecycle transition) ticket.
   * @param {object} [options]
   * @param {number} [options.drainTimeoutMs] 0 = wait forever for in-flight work
   * @param {() => void} [options.onDrainTimeout] called once when the drain times out
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<() => void>} release function
   */
  acquireExclusive({ drainTimeoutMs = 0, onDrainTimeout = null, signal } = {}) {
    if (this._aborted) {
      const error = new GateAbortedError('manager shutting down');
      return Promise.resolve().then(() => {
        throw error;
      });
    }
    const canStartImmediately =
      !this._exclusiveHeld && this._activeReaders === 0 && this._waitingExclusives.length === 0;
    if (canStartImmediately) {
      this._exclusiveHeld = true;
      return Promise.resolve(this._makeRelease('write'));
    }
    if (this.queueLength >= this.maxQueuedRequests) {
      return Promise.reject(new QueueFullError(this.maxQueuedRequests));
    }
    return this._enqueue(this._waitingExclusives, signal, 'write', { drainTimeoutMs, onDrainTimeout });
  }

  /**
   * @param {'read'|'write'} kind the ticket type this release belongs to
   */
  _makeRelease(kind) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'write') {
        this._exclusiveHeld = false;
      } else if (this._activeReaders > 0) {
        this._activeReaders -= 1;
      }
      this._drain();
    };
  }

  _enqueue(queue, signal, kind, extra = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        kind,
        resolve,
        reject,
        signal,
        drainTimeoutMs: extra.drainTimeoutMs ?? 0,
        onDrainTimeout: extra.onDrainTimeout ?? null,
        drainTimer: null,
        onAbort: null,
      };
      if (signal) {
        if (signal.aborted) {
          reject(new GateAbortedError('client disconnected while queued'));
          return;
        }
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (waiter.drainTimer) clearTimeout(waiter.drainTimer);
          reject(new GateAbortedError('client disconnected while queued'));
          // Removing a waiter can unblock others (e.g. a queued switch was the
          // only thing holding back readers), and it changes queue depth.
          this._drain();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.push(waiter);
      // _drain(), not _notify(): enqueueing an exclusive waiter is what has to
      // ARM its drain deadline. Calling only _notify() here left a queued
      // switch waiting forever when the in-flight request never finished.
      this._drain();
    });
  }

  _drain() {
    // Readers may run while no exclusive is pending or held.
    while (
      !this._exclusiveHeld &&
      this._waitingExclusives.length === 0 &&
      this._activeReaders < this.maxConcurrentRequests &&
      this._waitingReaders.length > 0
    ) {
      const waiter = this._waitingReaders.shift();
      this._grantRead(waiter);
    }
    if (!this._exclusiveHeld && this._waitingExclusives.length > 0) {
      const next = this._waitingExclusives[0];
      if (this._activeReaders === 0) {
        this._waitingExclusives.shift();
        this._grantWrite(next);
      } else if (!next.drainTimer && next.drainTimeoutMs > 0) {
        // Start the drain deadline once the transition could otherwise run.
        next.drainTimer = setTimeout(() => {
          next.drainTimer = null;
          if (this._waitingExclusives[0] !== next || this._exclusiveHeld) return;
          try {
            next.onDrainTimeout?.();
          } catch {
            /* never break the gate because a hook threw */
          }
          const index = this._waitingExclusives.indexOf(next);
          if (index >= 0) this._waitingExclusives.splice(index, 1);
          this._grantWrite(next, { forced: true });
        }, next.drainTimeoutMs);
        // NOT unref()'d -- deliberately. This deadline is the only thing that
        // can grant a queued exclusive waiter when the in-flight request never
        // finishes. `unref()` would let the event loop drain first and drop the
        // deadline entirely, leaving that waiter (and whoever awaits it) hung.
        // It is always cleared by _grantWrite()/_release()/abortAll(), so it
        // cannot outlive the transition it guards.
      }
    }
    this._notify();
  }

  _grantRead(waiter) {
    this._activeReaders += 1;
    this._settle(waiter, () => waiter.resolve(this._makeRelease('read')));
  }

  _grantWrite(waiter, { forced = false } = {}) {
    if (waiter.drainTimer) {
      clearTimeout(waiter.drainTimer);
      waiter.drainTimer = null;
    }
    this._exclusiveHeld = true;
    this._forcedWrite = forced;
    this._settle(waiter, () => waiter.resolve(this._makeRelease('write')));
  }

  _settle(waiter, action) {
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      if (waiter.kind === 'read') this._activeReaders = Math.max(0, this._activeReaders - 1);
      else this._exclusiveHeld = false;
      waiter.reject(new GateAbortedError('client disconnected while queued'));
      return;
    }
    action();
  }

  _notify() {
    try {
      this.onQueueChange?.(this.queueLength);
    } catch {
      /* ignore */
    }
  }
}

/** Trusted runtime hooks must honor the signal; late provision results get cleanup. */
export class StageTimeoutError extends Error {
  constructor(stage: string, ms: number) {
    super(`${stage} timed out after ${ms}ms`);
    this.name = "StageTimeoutError";
  }
}
export async function deadline<T>(
  stage: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  onLate?: (value: T) => Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = Promise.resolve().then(() => work(controller.signal));
  const bounded = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = new StageTimeoutError(stage, ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  void task
    .then(async (value) => {
      if (expired && onLate) await onLate(value);
    })
    .catch(() => {});
  try {
    return await Promise.race([task, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort(new Error(`${stage} scope ended`));
  }
}

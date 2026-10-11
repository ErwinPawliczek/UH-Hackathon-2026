// Fatal engine-error overlay: the hosted engine could not be reached, or its
// first request failed. Blocks the scene with a clear, retryable error — the
// app never falls back to the in-page stub. v3 style: hairline panel, Archivo
// title, mono detail, alarm red reserved for the bad state, one blue Retry.

export function EngineErrorOverlay({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/80" data-testid="fatal-error">
      <div className="panel flex max-w-md flex-col items-start gap-2 p-6">
        <h1 className="wordmark text-lg text-alarm" role="alert">
          Engine unavailable
        </h1>
        <p className="text-sm text-ink">
          The hosted simulation engine did not respond, so no run can start.
          Retry once it is reachable — the in-page stub is not a fallback.
        </p>
        <p className="data w-full break-all rounded-sm bg-panel-2 px-2 py-1 text-xs text-muted">
          {message}
        </p>
        <button className="btn btn-primary mt-1" onClick={onRetry} data-testid="retry-engine">
          Retry
        </button>
      </div>
    </div>
  );
}

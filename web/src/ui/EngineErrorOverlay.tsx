// Fatal engine-error overlay: the hosted engine could not be reached, or its
// first request failed. Blocks the scene with a clear, retryable error, in
// plain words. RunEndedOverlay is its sibling for a run the server has dropped. v3 style: hairline panel, Archivo
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
      <div className="chamfer flex max-w-md flex-col items-start gap-2 p-6">
        <h1 className="wordmark text-lg text-alarm" role="alert">
          Engine unavailable
        </h1>
        <p className="text-sm text-ink">
          The simulation runs on a server, and it is not answering, so nothing can start yet.
          Try again in a moment.
        </p>
        <p className="data w-full break-all rounded-sm bg-panel-2 px-2 py-1 text-xs text-muted">
          {message}
        </p>
        <button className="btn btn-primary mt-1" onClick={onRetry} data-testid="retry-engine">
          Try again
        </button>
      </div>
    </div>
  );
}

/** The server no longer has this run: say so once, with the one way forward. */
export function RunEndedOverlay({ onNewRun }: { onNewRun: () => void }) {
  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-white/80" data-testid="run-ended">
      <div className="chamfer flex max-w-md flex-col items-start gap-2 p-6">
        <h1 className="wordmark text-lg text-ink" role="alert">This run has ended</h1>
        <p className="text-sm text-ink">
          The server no longer has it: it was restarted, or the run sat paused for too long. Start a new one to carry on.
        </p>
        <button className="btn btn-primary mt-1" onClick={onNewRun} data-testid="new-run">
          Start a new one
        </button>
      </div>
    </div>
  );
}

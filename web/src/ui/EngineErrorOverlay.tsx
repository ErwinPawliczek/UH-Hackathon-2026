// Fatal engine-error overlay: the hosted engine could not be reached, or its
// first request failed. Blocks the scene with a clear, retryable error, in
// plain words. RunEndedOverlay is its sibling for a run the server has dropped. v3 style: hairline panel, Archivo
// title, mono detail, alarm red reserved for the bad state, one blue Retry.

export function EngineErrorOverlay({
  message,
  onRetry,
  custom = null,
}: {
  message: string;
  onRetry: () => void;
  /** the run was to be on a map from the map builder: the ways out are to edit it or to drop it */
  custom?: { editHref: string; onDefaultWorld: () => void } | null;
}) {
  if (custom !== null) {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/80" data-testid="fatal-error">
        <div className="chamfer flex max-w-md flex-col items-start gap-2 p-6">
          <h1 className="wordmark text-lg text-alarm" role="alert">This map cannot be run yet</h1>
          <p className="text-sm text-ink">The server looked at the map you drew and answered:</p>
          <p className="w-full break-words rounded-sm bg-panel-2 px-2 py-1 text-sm text-ink" data-testid="fatal-reason">{message}</p>
          <div className="mt-1 flex gap-2">
            <a className="btn btn-primary" href={custom.editHref} data-testid="error-edit-map">Edit map</a>
            <button className="btn" onClick={custom.onDefaultWorld} data-testid="error-default-world">Default world</button>
          </div>
        </div>
      </div>
    );
  }
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

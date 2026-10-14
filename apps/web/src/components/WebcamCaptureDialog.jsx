import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, RefreshCw } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

const CAPTURE_MIME = "image/jpeg";
const CAPTURE_QUALITY = 0.92;
const CAPTURE_FILENAME_PREFIX = "photo";
// Rear camera on phones (matches the old capture="environment"); desktops just get their webcam.
const VIDEO_CONSTRAINTS = { video: { facingMode: { ideal: "environment" } }, audio: false };

export const webcamSupported = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * WebcamCaptureDialog — live camera preview; "Take photo" grabs a frame and
 * hands it to `onCapture` as a File, so it drops into the same upload paths
 * a picked file uses. `onUnavailable` fires when the camera can't be opened
 * (denied, no device, insecure origin) so the caller can fall back.
 */
export default function WebcamCaptureDialog({ open, onClose, onCapture, onUnavailable }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia(VIDEO_CONSTRAINTS)
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; v.play?.().catch(() => {}); }
      })
      .catch((err) => { if (!cancelled) onUnavailable?.(err); });
    return () => { cancelled = true; stop(); };
    // onUnavailable is intentionally not a dep: a new closure each render must not restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stop]);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture(new File([blob], `${CAPTURE_FILENAME_PREFIX}-${Date.now()}.jpg`, { type: CAPTURE_MIME }));
      onClose();
    }, CAPTURE_MIME, CAPTURE_QUALITY);
  };

  return (
    <CenteredDialog open={open} onClose={onClose} testId="webcam-dialog" icon={Camera} title="Take a photo" maxWidth="max-w-md">
      <div className="space-y-3">
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            data-testid="webcam-video"
            playsInline
            muted
            onLoadedData={() => setReady(true)}
            className="h-full w-full object-cover"
          />
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center text-white/70">
              <Loader2 className="w-5 h-5 animate-spin" aria-label="Starting camera" />
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-11 border border-[var(--border)] hover:border-[var(--border-accent)] text-sm text-[var(--text-secondary)] rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="webcam-snap"
            disabled={!ready}
            onClick={snap}
            className="flex items-center justify-center gap-2 h-11 bg-[var(--accent)] text-[var(--bg-primary)] text-sm rounded-xl disabled:opacity-50 transition-opacity"
          >
            <Camera className="w-4 h-4" aria-hidden="true" /> Take photo
          </button>
        </div>
      </div>
    </CenteredDialog>
  );
}

/**
 * useWebcamCapture(onFile) → { openCamera, cameraUi }
 * Render `cameraUi` once in the component; call `openCamera()` from the button.
 * Falls back to the OS camera/file picker when no webcam is reachable.
 */
export function useWebcamCapture(onFile) {
  const [open, setOpen] = useState(false);
  const fallbackRef = useRef(null);

  const openFallback = useCallback(() => fallbackRef.current?.click(), []);
  const openCamera = useCallback(() => {
    if (webcamSupported()) setOpen(true);
    else openFallback();
  }, [openFallback]);

  const cameraUi = (
    <>
      <input
        ref={fallbackRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label="Take or choose a photo"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
      <WebcamCaptureDialog
        open={open}
        onClose={() => setOpen(false)}
        onCapture={onFile}
        onUnavailable={() => { setOpen(false); openFallback(); }}
      />
    </>
  );
  return { openCamera, cameraUi };
}

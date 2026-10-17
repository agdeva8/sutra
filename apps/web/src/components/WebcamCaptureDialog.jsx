import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Loader2, SwitchCamera, X } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import useMediaQuery from "../hooks/useMediaQuery";
import { useDialogBack } from "../hooks/useDialogBack";
import { MOBILE_MAX_WIDTH_PX } from "../constants/screens";

const CAPTURE_MIME = "image/jpeg";
const CAPTURE_QUALITY = 0.92;
const CAPTURE_FILENAME_PREFIX = "photo";

// Ask for a real photo, not the 640×480 thumbnail an unconstrained getUserMedia hands back on many
// phones — a stream that small is exactly what left the picture too blurry for triage to read.
// `ideal`, not `exact`, so a camera that cannot do 1920×1080 still opens on its closest mode
// instead of rejecting the whole request with an OverconstrainedError.
const CAPTURE_WIDTH_IDEAL = 1920;
const CAPTURE_HEIGHT_IDEAL = 1080;
// Rear lens first (matches the old capture="environment"); the phone viewfinder can flip to the
// front one. Desktops just get whatever webcam is attached.
const REAR_FACING = "environment";
const FRONT_FACING = "user";

const videoConstraints = (facing) => ({
  video: {
    facingMode: { ideal: facing },
    width: { ideal: CAPTURE_WIDTH_IDEAL },
    height: { ideal: CAPTURE_HEIGHT_IDEAL },
  },
  audio: false,
});

// A phone gets the full-screen viewfinder: a small screen (below Tailwind `sm`) or a coarse
// pointer (a touch device). Both conditions ride on one query, built from the shared mobile
// breakpoint so the two can never drift apart.
const PHONE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH_PX}px), (pointer: coarse)`;

export const webcamSupported = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * WebcamCaptureDialog — live camera preview; "Take photo" grabs a frame and
 * hands it to `onCapture` as a File, so it drops into the same upload paths
 * a picked file uses. `onUnavailable` fires when the camera can't be opened
 * (denied, no device, insecure origin) so the caller can fall back.
 *
 * A phone gets a full-screen viewfinder — the preview fills the display, with
 * close, flip and a large shutter within reach of a thumb — while a desktop
 * keeps the centred dialog. Either way the frame is grabbed through the same
 * canvas, so what reaches `onCapture` is identical.
 */
export default function WebcamCaptureDialog({ open, onClose, onCapture, onUnavailable }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState(REAR_FACING);
  // A frame held after the shutter, so the viewfinder can offer Retake / Use
  // photo before committing. Stays null on the desktop path, which commits the
  // frame the moment it is taken.
  const [shot, setShot] = useState(null);
  const shotUrlRef = useRef(null);
  const phone = useMediaQuery(PHONE_QUERY);

  // Back press closes the viewfinder. Armed only on a phone: the desktop dialog
  // never pushed a history sentinel, and this must not start pushing one now.
  useDialogBack(open && phone, onClose, "webcam-capture");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  const clearShot = useCallback(() => {
    if (shotUrlRef.current) {
      URL.revokeObjectURL(shotUrlRef.current);
      shotUrlRef.current = null;
    }
    setShot(null);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia(videoConstraints(facing))
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; v.play?.().catch(() => {}); }
      })
      .catch((err) => { if (!cancelled) onUnavailable?.(err); });
    return () => { cancelled = true; stop(); };
    // onUnavailable is intentionally not a dep: a new closure each render must not restart the stream.
    // `facing` IS a dep: flipping the camera has to reopen the stream on the other lens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, facing, stop]);

  // Closing drops the held frame (and its object URL) and points the lens back
  // at the rear camera, so the next open starts clean.
  useEffect(() => {
    if (open) return undefined;
    clearShot();
    setFacing(REAR_FACING);
    return undefined;
  }, [open, clearShot]);

  // Unmounting while the viewfinder is still open (the screen behind it went
  // away) drops the held frame too, so its object URL is not left behind. The
  // stream itself is already stopped by the streaming effect's own cleanup.
  useEffect(() => () => clearShot(), [clearShot]);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `${CAPTURE_FILENAME_PREFIX}-${Date.now()}.jpg`, { type: CAPTURE_MIME });
      // Desktop: hand the frame straight over and close, exactly as before.
      if (!phone) { onCapture(file); onClose(); return; }
      // Phone: hold the frame behind a preview so Retake can throw it away.
      shotUrlRef.current = URL.createObjectURL(blob);
      setShot({ file, url: shotUrlRef.current });
    }, CAPTURE_MIME, CAPTURE_QUALITY);
  };

  const flip = () => setFacing((f) => (f === REAR_FACING ? FRONT_FACING : REAR_FACING));

  if (open && phone) {
    // Portalled to the body: this branch renders inside whatever opened it (the chat composer, Add
    // Source, a goal's memory), and CenteredDialog's panel carries `gc-fade-up`, whose retained
    // transform makes that panel the containing block for fixed children — so `fixed inset-0` filled
    // the panel, not the screen. `z-[70]` sits above CenteredDialog's `z-[60]`.
    return createPortal(
      <div
        data-testid="webcam-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Take a photo"
        className="fixed inset-0 z-[70] flex h-[100dvh] flex-col bg-black gc-fade-in"
      >
        <video
          ref={videoRef}
          data-testid="webcam-video"
          playsInline
          muted
          onLoadedData={() => setReady(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* The frame just taken sits over the live view while Retake / Use photo are on screen. */}
        {shot && (
          <img src={shot.url} alt="" data-testid="webcam-review" className="absolute inset-0 h-full w-full object-cover" />
        )}
        {!ready && !shot && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70">
            <Loader2 className="w-5 h-5 animate-spin" aria-label="Starting camera" />
          </div>
        )}

        {/* Top bar — close on the left, flip on the right, clear of the status bar and the notch. */}
        <div className="relative z-10 flex items-center justify-between px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <button
            type="button"
            onClick={onClose}
            data-testid="webcam-dialog-close"
            title="Close"
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
          >
            <X className="w-5 h-5" />
          </button>
          {!shot && (
            <button
              type="button"
              onClick={flip}
              data-testid="webcam-flip"
              title="Switch camera"
              aria-label="Switch camera"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
            >
              <SwitchCamera className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Bottom controls — the shutter, or Retake / Use photo once a frame is held — sitting
            clear of the home indicator. */}
        <div className="relative z-10 mt-auto flex flex-col items-center gap-5 px-6 pb-[calc(env(safe-area-inset-bottom)+1.75rem)]">
          {shot ? (
            <div className="grid w-full grid-cols-2 gap-3">
              <button
                type="button"
                onClick={clearShot}
                data-testid="webcam-retake"
                className="h-12 rounded-full border border-white/70 text-[15px] font-medium text-white transition-colors hover:bg-white/10"
              >
                Retake
              </button>
              <button
                type="button"
                onClick={() => { onCapture(shot.file); onClose(); }}
                data-testid="webcam-use"
                className="h-12 rounded-full bg-white text-[15px] font-semibold text-black transition-opacity hover:opacity-90"
              >
                Use photo
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="webcam-snap"
              disabled={!ready}
              onClick={snap}
              title="Take photo"
              aria-label="Take photo"
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white/80 bg-white/20 transition-transform active:scale-95 disabled:opacity-50"
            >
              <span aria-hidden="true" className="h-14 w-14 rounded-full bg-white" />
            </button>
          )}
        </div>
      </div>,
      document.body,
    );
  }

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

import { expect, fn, userEvent, waitFor } from "storybook/test";
import WebcamCaptureDialog from "./WebcamCaptureDialog";

// Stand-in camera: a canvas stream, so the preview renders without a device or permission prompt.
const FAKE_FRAME = { width: 640, height: 480, fps: 5 };
function fakeCameraStream() {
  const canvas = document.createElement("canvas");
  canvas.width = FAKE_FRAME.width;
  canvas.height = FAKE_FRAME.height;
  const ctx = canvas.getContext("2d");
  let t = 0;
  const draw = () => {
    ctx.fillStyle = `hsl(${(t += 4) % 360} 40% 35%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "32px sans-serif";
    ctx.fillText("Fake camera", 40, 80);
  };
  draw();
  setInterval(draw, 1000 / FAKE_FRAME.fps);
  return canvas.captureStream(FAKE_FRAME.fps);
}

export default {
  title: "Components/WebcamCaptureDialog",
  component: WebcamCaptureDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: { open: true, onClose: fn(), onCapture: fn(), onUnavailable: fn() },
  beforeEach: () => {
    const original = navigator.mediaDevices?.getUserMedia;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => fakeCameraStream() },
    });
    return () => {
      if (original) navigator.mediaDevices.getUserMedia = original;
    };
  },
};

export const LivePreview = {};

export const TakesPhoto = {
  play: async ({ args }) => {
    const snap = document.querySelector('[data-testid="webcam-snap"]');
    await waitFor(() => expect(snap).toBeEnabled(), { timeout: 5000 });
    await userEvent.click(snap);
    await waitFor(() => expect(args.onCapture).toHaveBeenCalled());
    await expect(args.onCapture.mock.calls[0][0].type).toBe("image/jpeg");
  },
};

export const CameraDenied = {
  beforeEach: () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); } },
    });
  },
  play: async ({ args }) => {
    await waitFor(() => expect(args.onUnavailable).toHaveBeenCalled());
  },
};

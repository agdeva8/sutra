/**
 * install.js keeps its state at module level and `initInstall()` runs once, so
 * every test loads a fresh copy of the module and stubs the browser first.
 */

const original = {
  userAgent: Object.getOwnPropertyDescriptor(navigator, "userAgent"),
  platform: Object.getOwnPropertyDescriptor(navigator, "platform"),
  maxTouchPoints: Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints"),
  matchMedia: Object.getOwnPropertyDescriptor(window, "matchMedia"),
};

const define = (target, key, value) =>
  Object.defineProperty(target, key, { value, configurable: true });

/** Stub the browser facts the store reads, then return a fresh module. */
function load({ userAgent = "", platform = "", maxTouchPoints = 0, standalone = false } = {}) {
  define(navigator, "userAgent", userAgent);
  define(navigator, "platform", platform);
  define(navigator, "maxTouchPoints", maxTouchPoints);
  define(window, "matchMedia", (query) => ({
    matches: standalone && query.includes("display-mode: standalone"),
    addEventListener: () => {},
  }));

  let mod;
  jest.isolateModules(() => {
    mod = require("../install");
  });
  return mod;
}

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const crios = (version) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${version.replace(".", "_")} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1`;

afterEach(() => {
  for (const key of ["userAgent", "platform", "maxTouchPoints"]) {
    delete navigator[key];
    if (original[key]) Object.defineProperty(navigator, key, original[key]);
  }
  if (original.matchMedia) Object.defineProperty(window, "matchMedia", original.matchMedia);
  else delete window.matchMedia;
  jest.resetModules();
});

describe("the install store", () => {
  test("Android Chrome without a prompt points at the menu; a captured prompt switches it to chromium", () => {
    const { initInstall, getInstallState } = load({ userAgent: ANDROID_CHROME, platform: "Linux armv8l" });
    initInstall();

    expect(getInstallState()).toMatchObject({ platform: "android", canPrompt: false });

    window.dispatchEvent(new Event("beforeinstallprompt"));
    expect(getInstallState()).toMatchObject({ platform: "chromium", canPrompt: true });
  });

  test("iOS Safari offers the share sheet", () => {
    const { initInstall, getInstallState } = load({ userAgent: IOS_SAFARI, platform: "iPhone" });
    initInstall();
    expect(getInstallState().platform).toBe("ios");
  });

  test("Chrome on iOS offers the share sheet from 16.4, and nothing before it", () => {
    const seventeen = load({ userAgent: crios("17.0"), platform: "iPhone" });
    seventeen.initInstall();
    expect(seventeen.getInstallState().platform).toBe("ios");

    const sixteenThree = load({ userAgent: crios("16.3"), platform: "iPhone" });
    sixteenThree.initInstall();
    expect(sixteenThree.getInstallState().platform).toBe("none");
  });

  test("a standalone display-mode means already installed, with no platform", () => {
    const { initInstall, getInstallState } = load({ userAgent: IOS_SAFARI, standalone: true });
    initInstall();
    expect(getInstallState()).toMatchObject({ installed: true, platform: "none" });
  });

  test("appinstalled marks it installed and drops the prompt", () => {
    const { initInstall, getInstallState } = load({ userAgent: ANDROID_CHROME });
    initInstall();
    window.dispatchEvent(new Event("beforeinstallprompt"));
    expect(getInstallState().canPrompt).toBe(true);

    window.dispatchEvent(new Event("appinstalled"));
    expect(getInstallState()).toMatchObject({ installed: true, platform: "none", canPrompt: false });
  });
});

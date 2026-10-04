import { fallBackToStill, hideSplashWhenReady, SPLASH_MIN_MS } from "@/lib/splash";

function splash() {
  const element = document.createElement("div");
  element.id = "splash";
  document.body.append(element);
  return element;
}

describe("startup splash (#53)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays for at least three seconds, then fades out", () => {
    const element = splash();
    hideSplashWhenReady(element, { shownAt: 0, now: () => 500 });
    vi.advanceTimersByTime(SPLASH_MIN_MS - 500 - 1);
    expect(element.classList.contains("done")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(element.classList.contains("done")).toBe(true);
    expect(element.isConnected).toBe(true); // fading
    element.dispatchEvent(new Event("transitionend"));
    expect(element.isConnected).toBe(false);
  });

  it("goes as soon as the app is ready when that took longer", () => {
    const element = splash();
    hideSplashWhenReady(element, { shownAt: 0, now: () => 5000 });
    vi.advanceTimersByTime(0);
    expect(element.classList.contains("done")).toBe(true);
    vi.advanceTimersByTime(600); // no transitionend: removed anyway
    expect(element.isConnected).toBe(false);
  });

  it("does not fade with reduced motion", () => {
    const element = splash();
    hideSplashWhenReady(element, { shownAt: 0, now: () => SPLASH_MIN_MS, reducedMotion: true });
    vi.advanceTimersByTime(0);
    expect(element.isConnected).toBe(false);
  });

  it("shows the still logo when the animation cannot load", () => {
    const image = document.createElement("img");
    image.src = "/splash.webp";
    fallBackToStill(image, "/splash.png");
    image.dispatchEvent(new Event("error"));
    expect(image.src).toMatch(/\/splash\.png$/);
  });
});

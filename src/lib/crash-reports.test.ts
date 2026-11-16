import { backend, mockTauri } from "@/test/tauri";

const DSN = "https://public@o1.ingest.de.sentry.io/1";

/** A stand-in for `@sentry/browser`: records how the client is set up and shut down. */
const sdk = vi.hoisted(() => {
  const client = { getOptions: vi.fn(() => client.options), close: vi.fn(), options: {} as never };
  return {
    client,
    init: vi.fn((options: unknown) => {
      client.options = { ...(options as object) } as never;
      return client;
    }),
    setClient: vi.fn(),
    globalHandlersIntegration: vi.fn(() => ({ name: "GlobalHandlers" })),
    makeFetchTransport: vi.fn(),
  };
});

vi.mock("@sentry/browser", () => ({
  init: sdk.init,
  getCurrentScope: () => ({ setClient: sdk.setClient }),
  globalHandlersIntegration: sdk.globalHandlersIntegration,
  makeFetchTransport: sdk.makeFetchTransport,
}));

/** A fresh copy of the module: it keeps the running client in module state. */
async function load() {
  vi.resetModules();
  return import("@/lib/crash-reports");
}

beforeEach(() => {
  sdk.init.mockClear();
  sdk.setClient.mockClear();
  sdk.client.close.mockReset().mockResolvedValue(true);
  sdk.client.options = {} as never;
  vi.stubEnv("VITE_SENTRY_DSN_FRONTEND", DSN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("crash reports gating", () => {
  it("initialises nothing while the setting is off", async () => {
    mockTauri();
    backend.crashReports = { enabled: false, available: true };
    const { initCrashReports } = await load();
    await initCrashReports();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("initialises nothing without a UI DSN, whatever the user chose", async () => {
    vi.stubEnv("VITE_SENTRY_DSN_FRONTEND", "");
    mockTauri();
    backend.crashReports = { enabled: true, available: true };
    const { initCrashReports } = await load();
    await initCrashReports();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("initialises nothing when the core has no DSN (not available)", async () => {
    mockTauri();
    backend.crashReports = { enabled: true, available: false };
    const { initCrashReports } = await load();
    await initCrashReports();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("initialises nothing in a browser", async () => {
    const { initCrashReports } = await load();
    await initCrashReports();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("initialises nothing when the setting cannot be read", async () => {
    mockTauri({
      get_crash_report_settings: () => {
        throw { kind: "io", message: "no access" };
      },
    });
    const { initCrashReports } = await load();
    await initCrashReports();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("initialises once at startup when the user opted in", async () => {
    mockTauri();
    backend.crashReports = { enabled: true, available: true };
    const { initCrashReports } = await load();
    await initCrashReports();
    await initCrashReports();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init.mock.calls[0]?.[0]).toMatchObject({ dsn: DSN });
  });

  it("initialises after the switch is turned on, and not before the core stored it", async () => {
    const calls = mockTauri();
    backend.crashReports = { enabled: false, available: true };
    const { setCrashReports } = await load();
    const stored = await setCrashReports(true);
    expect(stored).toEqual({ enabled: true, available: true });
    expect(calls.map((c) => c.cmd)).toContain("set_crash_report_settings");
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it("does not initialise when the core stored the setting as off", async () => {
    mockTauri({ set_crash_report_settings: () => ({ enabled: false, available: true }) });
    const { setCrashReports } = await load();
    await setCrashReports(true);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("closes the client at once when the switch is turned off, before the core answers", async () => {
    let clientWasClosed = false;
    mockTauri({
      set_crash_report_settings: () => {
        clientWasClosed = sdk.client.close.mock.calls.length > 0;
        return { enabled: false, available: true };
      },
    });
    backend.crashReports = { enabled: true, available: true };
    const { initCrashReports, setCrashReports } = await load();
    await initCrashReports();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    const options = sdk.client.options as { enabled?: boolean };

    await setCrashReports(false);
    expect(clientWasClosed).toBe(true);
    expect(sdk.client.close).toHaveBeenCalledTimes(1);
    // Closed without waiting for the queue, and nothing can be captured by it any more.
    expect(sdk.client.close).toHaveBeenCalledWith(0);
    expect(options.enabled).toBe(false);
    expect(sdk.setClient).toHaveBeenCalledWith(undefined);
  });

  it("starts a new client when it is switched on again", async () => {
    mockTauri();
    backend.crashReports = { enabled: true, available: true };
    const { initCrashReports, setCrashReports } = await load();
    await initCrashReports();
    await setCrashReports(false);
    await setCrashReports(true);
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(sdk.client.close).toHaveBeenCalledTimes(1);
  });

  it("does not start when it is switched off while the SDK is still loading", async () => {
    mockTauri();
    const { applyCrashReportSettings } = await load();
    const starting = applyCrashReportSettings({ enabled: true, available: true });
    await applyCrashReportSettings({ enabled: false, available: true });
    await starting;
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("stops the client when the setting cannot be saved, and the core still says off", async () => {
    mockTauri({
      set_crash_report_settings: () => {
        throw { kind: "io", message: "disk on fire" };
      },
    });
    backend.crashReports = { enabled: true, available: true };
    const { initCrashReports, setCrashReports } = await load();
    await initCrashReports();
    await expect(setCrashReports(false)).rejects.toMatchObject({ message: "disk on fire" });
    // The core still has it on, so the client is back (the switch shows the stored state).
    expect(sdk.init).toHaveBeenCalledTimes(2);
  });
});

describe("crash report options", () => {
  async function options() {
    mockTauri();
    backend.crashReports = { enabled: true, available: true };
    const { initCrashReports } = await load();
    await initCrashReports();
    return sdk.init.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("turns the default integrations off and installs only the global error handlers", async () => {
    const o = await options();
    expect(o.defaultIntegrations).toBe(false);
    expect(o.integrations).toEqual([{ name: "GlobalHandlers" }]);
    expect(sdk.globalHandlersIntegration).toHaveBeenCalledTimes(1);
  });

  it("collects no personal data, breadcrumbs or client reports", async () => {
    const o = await options();
    expect(o.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
    expect(o.maxBreadcrumbs).toBe(0);
    expect(o.sendClientReports).toBe(false);
    expect(o.attachStacktrace).toBe(false);
  });

  it("configures no replay, tracing, profiling, logs, metrics or feedback", async () => {
    const o = await options();
    const keys = Object.keys(o).sort();
    expect(keys).toEqual(
      [
        "attachStacktrace",
        "beforeSend",
        "dataCollection",
        "defaultIntegrations",
        "dsn",
        "environment",
        "integrations",
        "maxBreadcrumbs",
        "release",
        "sendClientReports",
        "transport",
      ].sort(),
    );
    for (const key of keys.filter((k) => k !== "attachStacktrace")) {
      expect(key).not.toMatch(/replay|trac|profil|log|metric|feedback|sample|session|spotlight/i);
    }
  });

  it("sends the app version as the release", async () => {
    const { APP_VERSION } = await import("@/lib/project-info");
    expect((await options()).release).toBe(APP_VERSION);
  });
});

describe("detectOs", () => {
  it("names the system family and no version", async () => {
    const { detectOs } = await load();
    expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe(
      "macos",
    );
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe(
      "windows",
    );
    expect(detectOs("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
    expect(detectOs("Mozilla/5.0 (Linux; Android 14)")).toBeUndefined();
  });
});

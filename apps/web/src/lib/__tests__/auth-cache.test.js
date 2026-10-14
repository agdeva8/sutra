import {
  AUTH_CACHE_KEY,
  getCachedUser,
  setCachedUser,
  clearCachedUser,
  sanitizeUserForCache,
  isDifferentUser,
} from "../auth-cache";

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

describe("auth-cache helper", () => {
  beforeAll(() => {
    const mockStorage = new MemoryStorage();
    globalThis.localStorage = mockStorage;
    if (typeof globalThis.window === "undefined") {
      globalThis.window = {};
    }
    globalThis.window.localStorage = mockStorage;
  });

  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("performs cache write/read round-trip correctly", () => {
    const user = {
      id: "usr_123",
      user_id: "usr_123",
      email: "test@example.com",
      name: "Test User",
      picture: "https://example.com/avatar.png",
      model_provider: "anthropic",
      is_guest: false,
      persona_key: "dev",
    };

    setCachedUser(user);
    const cached = getCachedUser();

    expect(cached).toEqual({
      id: "usr_123",
      user_id: "usr_123",
      email: "test@example.com",
      name: "Test User",
      image: "https://example.com/avatar.png",
      picture: "https://example.com/avatar.png",
      model_provider: "anthropic",
      is_guest: false,
      persona_key: "dev",
    });
  });

  it("strips secrets, tokens, passwords, and arbitrary internal fields", () => {
    const dangerousPayload = {
      user_id: "usr_safe",
      name: "Safe Name",
      email: "safe@example.com",
      access_token: "secret_access_token_xyz",
      refresh_token: "secret_refresh_token_abc",
      password_hash: "$2b$12$e...",
      cookie_secret: "super_secret_cookie",
      internal_metadata: { role: "admin" },
    };

    const sanitized = sanitizeUserForCache(dangerousPayload);

    expect(sanitized.user_id).toBe("usr_safe");
    expect(sanitized.name).toBe("Safe Name");
    expect(sanitized.email).toBe("safe@example.com");
    expect(sanitized.access_token).toBeUndefined();
    expect(sanitized.refresh_token).toBeUndefined();
    expect(sanitized.password_hash).toBeUndefined();
    expect(sanitized.cookie_secret).toBeUndefined();
    expect(sanitized.internal_metadata).toBeUndefined();

    setCachedUser(dangerousPayload);
    const raw = JSON.parse(globalThis.localStorage.getItem(AUTH_CACHE_KEY));
    expect(raw.access_token).toBeUndefined();
    expect(raw.refresh_token).toBeUndefined();
  });

  it("clears cached user on clearCachedUser and when setting null", () => {
    setCachedUser({ id: "usr_1", name: "User" });
    expect(getCachedUser()).not.toBeNull();

    clearCachedUser();
    expect(getCachedUser()).toBeNull();
    expect(globalThis.localStorage.getItem(AUTH_CACHE_KEY)).toBeNull();

    setCachedUser({ id: "usr_1", name: "User" });
    setCachedUser(null);
    expect(getCachedUser()).toBeNull();
  });

  it("gracefully handles corrupt or unparseable JSON", () => {
    globalThis.localStorage.setItem(AUTH_CACHE_KEY, "invalid-json{{{");
    expect(getCachedUser()).toBeNull();
  });

  it("returns null if payload has no user identifier", () => {
    globalThis.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ name: "No ID" }));
    expect(getCachedUser()).toBeNull();
  });

  it("detects differences between cached and fresh users", () => {
    const cached = {
      user_id: "u1",
      email: "a@test.com",
      name: "Alpha",
      is_guest: true,
      model_provider: "gemini",
      persona_key: null,
    };

    // Identical
    expect(isDifferentUser(cached, { ...cached })).toBe(false);

    // Different id
    expect(isDifferentUser(cached, { ...cached, user_id: "u2" })).toBe(true);

    // Converted from guest to signed in
    expect(isDifferentUser(cached, { ...cached, is_guest: false })).toBe(true);

    // Changed model provider
    expect(isDifferentUser(cached, { ...cached, model_provider: "claude" })).toBe(true);

    // Changed persona
    expect(isDifferentUser(cached, { ...cached, persona_key: "sofia" })).toBe(true);

    // Changed name
    expect(isDifferentUser(cached, { ...cached, name: "Beta" })).toBe(true);
  });
});

/**
 * The browser upload's two routes, end to end at the compose level.
 *
 * The API signs a path and returns the key it minted; the client must PUT there and confirm with that
 * exact key. When the store refuses the bytes the same file must still attach through the API, because a
 * direct upload is an optimisation, not the only way in.
 */
import { api } from "../api";
import { postFile, putToUrl } from "../upload";

jest.mock("../upload", () => ({
  postFile: jest.fn(),
  putToUrl: jest.fn(),
}));

const SIGNED_KEY = "sources/user_1/0123456789ab-notes.txt";

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function file() {
  return new File(["hello"], "notes.txt", { type: "text/plain" });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

test("a direct upload PUTs to the signed URL and confirms with the key the sign step returned", async () => {
  global.fetch
    .mockResolvedValueOnce(
      response({ direct: true, key: SIGNED_KEY, upload_url: "https://store.example/object/upload?token=t" }),
    )
    .mockResolvedValueOnce(response({ id: "src_1" }));
  putToUrl.mockResolvedValue(null);
  const notes = file();

  await api.uploadSource(notes);

  expect(putToUrl).toHaveBeenCalledTimes(1);
  expect(putToUrl).toHaveBeenCalledWith(
    "https://store.example/object/upload?token=t",
    notes,
    undefined,
    "text/plain",
  );

  const [url, init] = global.fetch.mock.calls[1];
  expect(url).toContain("/sources/upload/complete");
  expect(JSON.parse(init.body).key).toBe(SIGNED_KEY);
  expect(postFile).not.toHaveBeenCalled();
});

test("a failed PUT falls back to the multipart upload", async () => {
  global.fetch.mockResolvedValueOnce(
    response({ direct: true, key: SIGNED_KEY, upload_url: "https://store.example/object/upload?token=t" }),
  );
  putToUrl.mockRejectedValue(new Error("store said no"));
  postFile.mockResolvedValue({ id: "src_2" });
  const notes = file();

  await api.uploadSource(notes, "goal_1", { purpose: "memory" });

  expect(postFile).toHaveBeenCalledTimes(1);
  const [url, posted, fields] = postFile.mock.calls[0];
  expect(url).toContain("/sources/upload");
  expect(posted).toBe(notes);
  expect(fields).toEqual({ goal_id: "goal_1", purpose: "memory" });
});

test("a failed confirm also falls back to the multipart upload", async () => {
  global.fetch
    .mockResolvedValueOnce(
      response({ direct: true, key: SIGNED_KEY, upload_url: "https://store.example/object/upload?token=t" }),
    )
    .mockResolvedValueOnce(response({ detail: "Upload did not reach storage" }, { ok: false, status: 409 }));
  putToUrl.mockResolvedValue(null);
  postFile.mockResolvedValue({ id: "src_3" });

  await api.uploadSource(file());

  expect(postFile).toHaveBeenCalledTimes(1);
});

test("with no store to sign for, the bytes post through the API", async () => {
  global.fetch.mockResolvedValueOnce(response({ direct: false, key: "", upload_url: "" }));
  postFile.mockResolvedValue({ id: "src_4" });

  await api.uploadSource(file());

  expect(putToUrl).not.toHaveBeenCalled();
  expect(postFile).toHaveBeenCalledTimes(1);
});

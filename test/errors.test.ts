import { describe, expect, it } from "vitest";
import { AppError, toErrorResponse } from "../src/errors";

// S01 AC 3 needs an AppError-shaped failure for slugify. This is the
// architecture-05 contract, created minimally now (toErrorResponse arrives
// with the error boundary in S12).

describe("AppError (architecture 05 contract)", () => {
  it("carries a stable code, HTTP status, and a safe public message", () => {
    const err = new AppError(
      "invalid_slug",
      400,
      "Name contains no characters that can form a slug.",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AppError");
    expect(err.code).toBe("invalid_slug");
    expect(err.status).toBe(400);
    expect(err.publicMessage).toBe("Name contains no characters that can form a slug.");
    expect(err.message).toBe("Name contains no characters that can form a slug.");
    expect(err.detail).toBeUndefined();
  });

  it("carries optional internal detail that is never sent to clients", () => {
    const err = new AppError("invalid_slug", 400, "msg", { input: "日本語" });
    expect(err.detail).toEqual({ input: "日本語" });
    expect(err.publicMessage).toBe("msg");
  });
});

describe("toErrorResponse", () => {
  it("returns a JSON body with the error code and status", () => {
    const err = new AppError("db_read_failed", 500, "Database read failed.");
    const headers = new Headers();
    headers.set("Cache-Control", "no-store");
    const res = toErrorResponse(err, headers);

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("does not leak the internal detail or stack", async () => {
    const err = new AppError("db_read_failed", 500, "Database read failed.", { cause: "secret" });
    const res = toErrorResponse(err, new Headers());
    const body = await res.json();
    expect(body).toEqual({ error: "db_read_failed" });
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("stack");
  });
});

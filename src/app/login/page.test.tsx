// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(cleanup);

  it("says why the last attempt was refused when the login route sends the browser back", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ error: "invalid" }) }));
    expect(screen.getByRole("alert").textContent).toBe("That password is not right. Try again.");
    expect(screen.getByPlaceholderText("Password")).toBeTruthy();
  });

  it("shows nothing for a reason it does not know, and nothing on a fresh visit", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ error: "<script>" }) }));
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

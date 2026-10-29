// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { rememberWorkHref, useWorkHref } from "./workHref";

describe("useWorkHref", () => {
  beforeEach(() => sessionStorage.clear());

  it("is the full feed until a scoped feed has been visited in this tab", () => {
    expect(renderHook(() => useWorkHref()).result.current).toBe("/");
    rememberWorkHref("/?repo=r1&view=queue");
    expect(renderHook(() => useWorkHref()).result.current).toBe("/?repo=r1&view=queue");
  });
});

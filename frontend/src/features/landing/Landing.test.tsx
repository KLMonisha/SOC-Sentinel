import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Landing from "./Landing";

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<p>Operational app</p>} />
      </Routes>
    </MemoryRouter>,
  );

const prefersReduced = (reduced: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));

beforeEach(() => {
  // jsdom has no WebGL: the landing page must take its static fallback path without errors.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("landing page", () => {
  test("falls back to the poster (no canvas) when WebGL is unavailable", () => {
    prefersReduced(false);
    const { container } = mount();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("img.ln-poster")).not.toBeNull();
  });

  test("copy is real DOM text and the scene is labelled illustrative, not live telemetry", () => {
    prefersReduced(false);
    mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/What would change my mind/i);
    expect(screen.getAllByText(/Illustrative/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not live telemetry/i).length).toBeGreaterThan(0);
  });

  test("reduced motion: motion is off, the toggle is disabled and no entrance gating remains", () => {
    prefersReduced(true);
    const { container } = mount();
    expect(container.querySelector(".ln")).toHaveAttribute("data-calm", "true");
    expect(screen.getByRole("button", { name: /Motion off/i })).toBeDisabled();
    expect(container.querySelector(".ln-pre")).toBeNull();
  });

  test("the motion toggle switches modes and remembers the choice", async () => {
    prefersReduced(false);
    const { container } = mount();
    const toggle = screen.getByRole("button", { name: /Motion on/i });
    await userEvent.click(toggle);
    expect(container.querySelector(".ln")).toHaveAttribute("data-calm", "true");
    expect(window.localStorage.getItem("soc-sentinel.landing.motion")).toBe("off");
  });

  test("Enter SOC Sentinel opens the operational app at /app", async () => {
    prefersReduced(true);
    mount();
    await userEvent.click(screen.getAllByRole("link", { name: /Enter SOC Sentinel/i, hidden: true })[0]!);
    expect(await screen.findByText("Operational app")).toBeInTheDocument();
  });
});

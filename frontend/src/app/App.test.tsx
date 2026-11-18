import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

test("the operational app lives at /app with primary navigation and the dry-run label", () => {
  at("/app");
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  expect(screen.getByText("CONTAINMENT: DRY-RUN")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Command Center" })).toBeInTheDocument();
});

test("pre-landing deep links are preserved by redirecting under /app", async () => {
  at("/red-team");
  expect(await screen.findByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  expect(screen.getByText("Red Team Lab", { selector: "h1, h2, p, span" })).toBeInTheDocument();
});

test("/ opens the landing page (lazy-loaded), not the application shell", async () => {
  at("/");
  expect(await screen.findByRole("heading", { name: /SOC Sentinel\. What would change my mind/i }, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  for (const l of screen.getAllByRole("link", { name: /Enter SOC Sentinel/i, hidden: true })) expect(l).toHaveAttribute("href", "/app");
});

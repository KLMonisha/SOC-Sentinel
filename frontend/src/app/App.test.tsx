import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

test("renders shell with primary navigation and dry-run label", () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  expect(screen.getByText("CONTAINMENT: DRY-RUN")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Command Center" })).toBeInTheDocument();
});

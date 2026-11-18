import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver (used by React Flow).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

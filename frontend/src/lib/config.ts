/** Central runtime config. Mocks are opt-in and never a silent fallback. */
export const config = {
  useMocks: import.meta.env.VITE_USE_MOCKS === "true",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
} as const;

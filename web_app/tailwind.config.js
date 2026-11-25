/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'IBM Plex Sans'", "'Noto Sans Bengali'", "system-ui", "-apple-system", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        canvas: "var(--bg-canvas)",
        surface: "var(--bg-surface)",
        sunken: "var(--bg-surface-sunken)",
        elevated: "var(--bg-surface-elevated)",
        ink: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          inverse: "var(--text-inverse)",
        },
        brand: {
          DEFAULT: "var(--primary)",
          hover: "var(--primary-hover)",
          soft: "var(--primary-soft-bg)",
          softText: "var(--primary-soft-text)",
        },
        warn: {
          DEFAULT: "var(--warning)",
          bg: "var(--warning-bg)",
          text: "var(--warning-text)",
          border: "var(--warning-border)",
        },
        fault: {
          DEFAULT: "var(--fault)",
          bg: "var(--fault-bg)",
          text: "var(--fault-text)",
          border: "var(--fault-border)",
        },
        ood: {
          bg: "var(--ood-bg)",
          text: "var(--ood-text)",
          border: "var(--ood-border)",
        },
        line: {
          subtle: "var(--border-subtle)",
          input: "var(--border-input)",
        },
      },
    },
  },
  plugins: [],
};

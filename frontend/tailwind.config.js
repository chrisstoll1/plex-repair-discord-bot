/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111316",
        panel: "#191c20",
        line: "#30343a",
        signal: "#f2b84b",
        cyan: "#7aa7d9",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 12px 32px rgba(0,0,0,.22)",
      },
    },
  },
  plugins: [],
};

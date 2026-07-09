/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#070a0d",
        panel: "#0d1217",
        line: "#202931",
        signal: "#d5ff45",
        cyan: "#47d7e8",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(213,255,69,.15), 0 16px 50px rgba(0,0,0,.35)",
      },
    },
  },
  plugins: [],
};

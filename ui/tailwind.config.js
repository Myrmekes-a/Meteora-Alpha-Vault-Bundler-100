const path = require("path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, "src/**/*.{js,ts,jsx,tsx,mdx}"),
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0b0e",
        card: "#111318",
        border: "#1e2028",
        accent: "#00ff88",
        danger: "#ff4444",
        warn: "#f5a623",
        muted: "#4a5060",
        "text-primary": "#e8eaf0",
        "text-secondary": "#8b92a5",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "Courier New", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      animation: {
        "pulse-green": "pulse-green 2s ease-in-out infinite",
        "glow-live": "glow-live 1.5s ease-in-out infinite",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.3s ease-out",
        "toast-in": "toast-in 0.25s ease-out",
        "countdown-tick": "countdown-tick 1s ease-in-out infinite",
      },
      keyframes: {
        "pulse-green": {
          "0%, 100%": { boxShadow: "0 0 4px rgba(0,255,136,0.4)" },
          "50%": { boxShadow: "0 0 12px rgba(0,255,136,0.8)" },
        },
        "glow-live": {
          "0%, 100%": {
            boxShadow: "0 0 10px rgba(0,255,136,0.5), 0 0 30px rgba(0,255,136,0.2)",
            borderColor: "rgba(0,255,136,0.6)",
          },
          "50%": {
            boxShadow: "0 0 25px rgba(0,255,136,0.9), 0 0 60px rgba(0,255,136,0.4)",
            borderColor: "rgba(0,255,136,1)",
          },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { transform: "translateY(8px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        "toast-in": {
          from: { transform: "translateX(120%)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "countdown-tick": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
      },
    },
  },
  plugins: [],
};

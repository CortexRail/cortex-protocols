// Tailwind CSS v4 is wired through its PostCSS plugin. globals.css imports it
// via `@import "tailwindcss";`.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;

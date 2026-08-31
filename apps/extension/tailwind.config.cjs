module.exports = {
  content: [
    "./src/**/*.{ts,tsx}"
  ],
  safelist: ["font-orbitron", "font-excessive"],
  theme: {
    extend: {
      fontFamily: {
        orbitron: ['"Orbitron"', "system-ui", "sans-serif"],
        excessive: ['"Excessive"', "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
}

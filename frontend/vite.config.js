import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages project site — served from https://<user>.github.io/movie-roulette/
  base: '/movie-roulette/',
  plugins: [react()],
  test: {
    // src/api.js's real-fetch path only touches fetch()/URL — no DOM needed,
    // so the plain Node environment is enough and avoids a jsdom dependency.
    environment: 'node',
  },
})

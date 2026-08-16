import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// `base` matters for the GitHub Pages deployment: the site is served from
// https://<user>.github.io/AMM_Hedging/, so built asset URLs must be prefixed
// with the repo name. Locally (and on any root-served host) base stays '/'.
// The Pages workflow sets BASE_PATH=/AMM_Hedging/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
})

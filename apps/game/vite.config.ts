import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    // React Compiler handles memoisation, so components here do not hand-write
    // useMemo/useCallback around render work.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  worker: {
    // The worker imports workspace packages as ES modules; the classic worker
    // format cannot.
    format: 'es',
  },
  build: {
    target: 'es2023',
  },
})

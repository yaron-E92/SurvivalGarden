import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '/contracts': resolve(__dirname, 'src/contracts'),
      '/domain': resolve(__dirname, 'src/domain'),
      '/data': resolve(__dirname, 'src/data'),
      '/app': resolve(__dirname, 'src/app')
    }
  }
});

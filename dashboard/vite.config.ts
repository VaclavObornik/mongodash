import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { viteSingleFile } from "vite-plugin-singlefile"

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue(), viteSingleFile()],
    base: './',
    build: {
        outDir: '../dist/dashboard',
        emptyOutDir: true,
    },
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, '../src/task-management')
        }
    },
    server: {
        fs: {
            allow: ['..']
        },
        proxy: {
            '/tasks/api': {
                target: 'http://localhost:3000',
                changeOrigin: true
            }
        }
    }
})

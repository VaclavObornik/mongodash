import json from '@rollup/plugin-json';
import babel from '@rollup/plugin-babel';
import replace from '@rollup/plugin-replace';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import sourceMaps from 'rollup-plugin-sourcemaps';
import typescript from 'rollup-plugin-typescript2';
import { terser } from 'rollup-plugin-terser';

const pkg = require('./package.json');

const libraryName = pkg.name.indexOf('/') > 0 ? pkg.name.split('/')[1].toLocaleLowerCase() : pkg.name.toLocaleLowerCase();

export default {
  input: `src/index.ts`,
  output: [
    {
      file: pkg.main,
      name: libraryName,
      format: 'umd',
      sourcemap: true,
      globals: {
        // "react": "React",
        // "react-dom": "ReactDOM",
      },
    },
    { file: pkg.module, format: 'es', sourcemap: true },
  ],
  // Indicate here external modules you don"t wanna include in your bundle (i.e.: "lodash")
  external: [],
  watch: {
    include: 'src/**',
  },
  plugins: [
    replace({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE)
    }),
    terser(),
    // Allow json resolution
    json(),
    // Compile TypeScript files
    typescript({
      tsconfig: './tsconfig.json',
      useTsconfigDeclarationDir: true,
    }),
    // Allow bundling cjs modules (unlike webpack, rollup doesn't understand cjs)
    commonjs({
      include: 'node_modules/**',
    }),
    // Allow node_modules resolution, so you can use "external" to control
    // which external modules to include in the bundle
    // https://github.com/rollup/rollup-plugin-node-resolve#usage
    resolve({
      browser: true,
    }),

    babel({
      exclude: 'node_modules/**',
    }),

    // Resolve source maps to the original source
    sourceMaps(),
  ],
};

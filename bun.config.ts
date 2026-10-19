// Bun-specific optimizations for maximum performance
export default {
  // Enable experimental JIT compilation
  jit: true,

  // Optimize for speed over memory usage
  smol: false,

  // Enable all optimizations
  minify: {
    whitespace: true,
    identifiers: true,
    syntax: true,
  },

  // Target modern environments for better optimization
  target: 'bun',

  // Enable tree shaking
  splitting: false,

  // Optimize bundle size
  external: ['ws'],
};

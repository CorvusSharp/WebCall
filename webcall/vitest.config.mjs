export default {
  test: {
    environment: 'jsdom',
    include: ['app/presentation/static/js/__tests__/**/*.test.mjs'],
    globals: false,
    reporters: 'default',
    setupFiles: ['app/presentation/static/js/__tests__/setup.mjs'],
    restoreMocks: true,
  }
};

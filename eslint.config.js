// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', '**/.anchor/**', '**/*.d.ts', 'packages/core/wasm/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Amounts must never reach the logs. console.* bypasses the redacting logger.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Operational scripts print to the terminal and parse untyped JSON-RPC
    // responses from Solana, NEAR and Supabase.
    files: ['scripts/**', 'programs/**/tests/**', 'programs/**/scripts/**'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);

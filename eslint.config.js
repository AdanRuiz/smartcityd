import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**', '**/.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/scripts/**'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'console',
          'process',
          'Buffer',
          'fetch',
          'URL',
          'URLSearchParams',
          'WebSocket',
          'performance',
          'setTimeout',
          'clearTimeout',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
)

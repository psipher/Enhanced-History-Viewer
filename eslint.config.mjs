import globals from 'globals'
import pluginJs from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
      },
      sourceType: 'module',
    },
  },
  pluginJs.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['lint_log.txt'],
  },
]

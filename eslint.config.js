import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'functions/lib/**', 'worker/dist/**', 'src/components.d.ts', '.emulator-data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // PrimeVue components are PascalCase single words (Button, Card, Tag…).
      'vue/multi-word-component-names': 'off',
      // Whitespace and attribute wrapping are a formatter's job. This project
      // has no Prettier step, so these rules would only produce noise that
      // hides real findings.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      // Test files legitimately define several probe components in one file.
      'vue/one-component-per-file': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/sw.ts'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
  {
    files: ['functions/**/*.{ts,mjs}', 'worker/**/*.{ts,mjs}', 'scripts/**/*.mjs', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      // The codebase uses `let x = init; try { x = … } catch { x = init }` on
      // purpose for fallible lookups. Kept visible as a warning rather than
      // rewriting deliberate, readable code.
      'no-useless-assignment': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
);

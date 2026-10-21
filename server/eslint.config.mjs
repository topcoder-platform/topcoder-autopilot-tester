import tseslint from 'typescript-eslint';

export default [{ files: ['src/**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-constant-condition': 'error', 'no-dupe-args': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error' } }];

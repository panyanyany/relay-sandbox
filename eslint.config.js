import tseslint from "typescript-eslint";
// 入口只做转换；业务模块同样接受严格的基础规则检查。
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".local/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);

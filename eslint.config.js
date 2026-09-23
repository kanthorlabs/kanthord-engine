import tseslint from "typescript-eslint";

const comparisonLiteral =
  ':matches(Literal[value=type(string)], Literal[value=type(number)], TemplateLiteral[expressions.length=0], UnaryExpression[operator="-"][argument.type="Literal"][argument.value=type(number)])';
const comparisonMessage =
  "Use a meaningfully named enum member or constant instead of a string or numeric literal in a comparison.";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", ".data/**"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `BinaryExpression[operator=/^(===|!==|==|!=|<|<=|>|>=)$/] > ${comparisonLiteral}`,
          message: comparisonMessage,
        },
        {
          selector: `SwitchCase > ${comparisonLiteral}.test`,
          message: comparisonMessage,
        },
        ...[1, 2].map((position) => ({
          selector: `CallExpression[callee.object.name="assert"][callee.property.name=/^(equal|notEqual|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual)$/] > ${comparisonLiteral}.arguments:nth-child(${position})`,
          message: comparisonMessage,
        })),
      ],
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
);

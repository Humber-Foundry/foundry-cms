import { _ } from "ajv/dist/compile/codegen/index.js";

export const siteDefinitionValidationKeywords = [
  {
    keyword: "xFoundryCropWithinSource",
    schemaType: "boolean",
    type: "object",
    code(context) {
      if (context.schema === true) {
        const { data } = context;
        context.fail(
          _`${data}.x + ${data}.width > 1 || ${data}.y + ${data}.height > 1`,
        );
      }
    },
  },
];

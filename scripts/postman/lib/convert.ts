import Converter, { type Options } from "openapi-to-postmanv2";
import type { PostmanCollection } from "./types.js";

const OPTIONS: Options = {
  schemaFaker: true,
  requestParametersResolution: "Example",
  exampleParametersResolution: "Example",
  folderStrategy: "Tags",
  includeAuthInfoInExample: true,
};

export function convertSpec(
  specString: string
): Promise<PostmanCollection> {
  return new Promise((resolve, reject) => {
    Converter.convert(
      { type: "string", data: specString },
      OPTIONS,
      (err, result) => {
        if (err) {
          reject(new Error(`Conversion error: ${err.message}`));
          return;
        }
        if (!result?.result) {
          reject(new Error(`Conversion failed: ${result?.reason}`));
          return;
        }
        const output = result.output?.[0];
        if (!output) {
          reject(new Error("Conversion produced no output"));
          return;
        }
        resolve(output.data as PostmanCollection);
      }
    );
  });
}

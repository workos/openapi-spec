import Converter from "openapi-to-postmanv2";
import type {
  ConversionOptions,
  ConversionResult,
  PostmanCollection,
} from "./types.js";

const OPTIONS: ConversionOptions = {
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
      (err: Error | null, result: ConversionResult) => {
        if (err) {
          reject(new Error(`Conversion error: ${err.message}`));
          return;
        }
        if (!result.result) {
          reject(new Error(`Conversion failed: ${result.reason}`));
          return;
        }
        resolve(result.output[0].data as PostmanCollection);
      }
    );
  });
}

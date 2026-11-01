// Typed reads of JSON responses in route tests.
import { ApiError } from "../../src/contract/common.ts";

export async function errorOf(response: Response) {
  return ApiError.parse(await response.json()).error;
}

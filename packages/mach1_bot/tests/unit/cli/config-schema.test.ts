import * as fs from "fs";
import {
  getTomlConfigSchemaPath,
  loadTomlConfigSchema,
  tomlConfigSchema,
} from "@/cli/utils/config-schema";

describe("config schema", () => {
  it("loads canonical TOML config schema JSON", () => {
    const expected = JSON.parse(
      fs.readFileSync(getTomlConfigSchemaPath(), "utf8"),
    );

    expect(loadTomlConfigSchema()).toEqual(expected);
    expect(tomlConfigSchema).toEqual(expected);
  });
});

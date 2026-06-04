import * as fs from "fs";
import * as path from "path";
import {
  getTomlConfigSchemaPath,
  loadTomlConfigSchema,
  resolveTomlConfigSchemaPath,
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

  it("resolves schema path from bundled CLI output directory", () => {
    const bundledCliDir = path.join(process.cwd(), "dist", "cli");
    const expected = path.join(
      process.cwd(),
      "schema",
      "toml-config.schema.json",
    );

    expect(resolveTomlConfigSchemaPath(bundledCliDir)).toBe(expected);
  });
});

import * as fs from "fs";
import * as path from "path";

type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface TomlConfigSchemaNode {
  type?: JsonSchemaType | JsonSchemaType[];
  title?: string;
  description?: string;
  properties?: Record<string, TomlConfigSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: Array<string | number | boolean | null>;
  items?: TomlConfigSchemaNode;
  const?: string | number | boolean | null;
  allOf?: Array<{
    if: TomlConfigSchemaNode;
    then: TomlConfigSchemaNode;
  }>;
}

export interface TomlConfigSchema extends TomlConfigSchemaNode {
  $schema: string;
}

export function resolveTomlConfigSchemaPath(fromDir: string): string {
  let currentDir = path.resolve(fromDir);

  while (true) {
    const candidate = path.join(
      currentDir,
      "schema",
      "toml-config.schema.json",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `Unable to locate toml-config.schema.json from ${fromDir}`,
      );
    }

    currentDir = parentDir;
  }
}

export function getTomlConfigSchemaPath(): string {
  return resolveTomlConfigSchemaPath(__dirname);
}

export function loadTomlConfigSchema(): TomlConfigSchema {
  return JSON.parse(
    fs.readFileSync(getTomlConfigSchemaPath(), "utf8"),
  ) as TomlConfigSchema;
}

export const tomlConfigSchema = loadTomlConfigSchema();

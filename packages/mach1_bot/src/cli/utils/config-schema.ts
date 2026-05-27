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

export function getTomlConfigSchemaPath(): string {
  return path.resolve(__dirname, "../../../schema/toml-config.schema.json");
}

export function loadTomlConfigSchema(): TomlConfigSchema {
  return JSON.parse(
    fs.readFileSync(getTomlConfigSchemaPath(), "utf8"),
  ) as TomlConfigSchema;
}

export const tomlConfigSchema = loadTomlConfigSchema();

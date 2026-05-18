import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const SEGMENTS = [
  `${path.sep}@0xmonaco${path.sep}core${path.sep}dist${path.sep}`,
  `${path.sep}@0xmonaco${path.sep}types${path.sep}dist${path.sep}`,
  `${path.sep}@0xmonaco${path.sep}contracts${path.sep}dist${path.sep}`,
];

export async function resolve(specifier, context, next) {
  const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : null;
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");

  if (parentPath && SEGMENTS.some((segment) => parentPath.includes(segment)) && isRelative) {
    const basePath = path.resolve(path.dirname(parentPath), specifier);
    const baseNoExt = basePath.endsWith(".js") ? basePath.slice(0, -3) : basePath;
    const candidates = [
      basePath,
      `${basePath}.js`,
      path.join(basePath, "index.js"),
      `${baseNoExt}.js`,
      path.join(baseNoExt, "index.js"),
    ];

    const found = candidates.find((candidate) => {
      try {
        const stats = fs.statSync(candidate);
        return stats.isFile();
      } catch {
        return false;
      }
    });

    if (found) {
      return { url: pathToFileURL(found).href, shortCircuit: true };
    }
  }

  return next(specifier, context);
}
